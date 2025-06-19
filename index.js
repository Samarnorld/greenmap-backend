// index.js
const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());

// ✅ Write service account key from env variable
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json');

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  console.error('❌ Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env variable.');
  process.exit(1);
}

fs.writeFileSync(SERVICE_ACCOUNT_PATH, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
console.log('🔐 Service account key written to file');

// ✅ Authenticate using the written key
const serviceKey = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH));

ee.data.authenticateViaPrivateKey(
  serviceKey,
  () => {
    ee.initialize(null, null, () => {
      console.log('✅ Earth Engine initialized successfully');
      startServer(); // start backend only after EE is ready
    });
  },
  (err) => {
    console.error('❌ EE authentication failed:', err);
  }
);


// ✅ Server logic (starts after EE init)
function startServer() {
  const wards = ee.FeatureCollection("projects/greenmap-backend/assets/nairobi_wards_filtered");

  function serveTile(image, visParams, res) {
    const styled = image.visualize(visParams).clip(wards);
    styled.getMap({}, (map, err) => {
      if (err || !map || !map.urlFormat) {
        return res.status(500).json({ error: 'Failed to generate map tile.', err });
      }
      res.json({ urlFormat: map.urlFormat });
    });
  }

  app.get('/ndvi', (req, res) => {
    const ndvi = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(wards)
      .filterDate('2024-01-01', '2025-05-25')
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .median()
      .normalizedDifference(['B8', 'B4'])
      .rename('NDVI');

    serveTile(ndvi, {
      min: 0,
      max: 0.8,
      palette: ['red', 'yellow', 'green']
    }, res);
  });

  app.get('/lst', (req, res) => {
    const lst = ee.ImageCollection('MODIS/061/MOD11A1')
      .filterBounds(wards)
      .filterDate('2024-01-01', '2025-05-25')
      .select('LST_Day_1km')
      .mean()
      .multiply(0.02)
      .subtract(273.15)
      .rename('LST_C');

    serveTile(lst, {
      min: 25,
      max: 45,
      palette: ['blue', 'yellow', 'red']
    }, res);
  });

  app.get('/ndvi-mask', (req, res) => {
    const ndvi = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(wards)
      .filterDate('2024-01-01', '2025-05-25')
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .median()
      .normalizedDifference(['B8', 'B4'])
      .rename('NDVI');

    const mask = ndvi.updateMask(ndvi.gt(0.3));

    serveTile(mask, {
      min: 0.3,
      max: 0.8,
      palette: ['yellow', 'green']
    }, res);
  });

  app.get('/', (req, res) => {
    res.send('🌍 GreenMap EE backend is running');
  });

  app.listen(PORT, () => {
    console.log(`🚀 Backend running at http://localhost:${PORT}`);
  });
}
