// index.js
const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());

// ✅ Path to your service account key
const privateKey = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

// ✅ Authenticate using the private key method
ee.data.authenticateViaPrivateKey(
  privateKey,
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
  const endDate = ee.Date(Date.now());
  const startDate = endDate.advance(-120, 'day');

  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
    .select(['B4', 'B8']);

  const ndvi = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
    ee.Image().rename('NDVI')
  );

  serveTile(ee.Image(ndvi), {
    min: 0,
    max: 0.8,
    palette: ['red', 'yellow', 'green']
  }, res);
});
app.get('/lst', (req, res) => {
  const endDate = ee.Date(Date.now());
  const startDate = endDate.advance(-120, 'day');

  const lst = ee.ImageCollection('MODIS/061/MOD11A1')
    .filterBounds(wards)
    .filterDate(startDate, endDate)
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
  const endDate = ee.Date(Date.now());
  const startDate = endDate.advance(-120, 'day');

  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(startDate, endDate)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
    .select(['B4', 'B8']);

  const ndvi = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
    ee.Image().rename('NDVI')
  );

  const mask = ee.Image(ndvi).updateMask(ee.Image(ndvi).gt(0.3));

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
