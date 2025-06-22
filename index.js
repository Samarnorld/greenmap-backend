// index.js
const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

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
  const inputDate = req.query.date ? ee.Date(req.query.date) : ee.Date(Date.now());
const endDate = inputDate;
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
  const inputDate = req.query.date ? ee.Date(req.query.date) : ee.Date(Date.now());
const endDate = inputDate;
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
  const inputDate = req.query.date ? ee.Date(req.query.date) : ee.Date(Date.now());
const endDate = inputDate;
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
app.get('/ndvi-anomaly', async (req, res) => {
  const currentDate = req.query.current ? ee.Date(req.query.current) : ee.Date(Date.now());
  const pastDate = req.query.past ? ee.Date(req.query.past) : ee.Date(Date.now()).advance(-1, 'year');

  function getNDVI(date) {
    const start = date.advance(-120, 'day');
    const end = date;
    const year = date.get('year');

    const sentinel = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(wards)
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .select(['B4', 'B8']);

    const landsat = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
      .filterBounds(wards)
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUD_COVER', 10))
      .select(['SR_B4', 'SR_B5'])
      .map(img => img.multiply(0.0000275).add(-0.2).copyProperties(img, img.propertyNames())); // scale SR bands

    const useSentinel = year.gte(2015);

    const ndvi = ee.Algorithms.If(
      useSentinel,
      sentinel.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
      landsat.median().normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI')
    );

    return ee.Image(ndvi);
  }

  const currentNDVI = getNDVI(currentDate);
  const pastNDVI = getNDVI(pastDate);
  const anomaly = ee.Image(currentNDVI).subtract(ee.Image(pastNDVI)).rename('NDVI_Anomaly');

  serveTile(anomaly, {
    min: -0.4,
    max: 0.4,
    palette: ['#d7191c', '#ffffbf', '#1a9641'] // red: loss, yellow: no change, green: gain
  }, res);
});
app.get('/rainfall', (req, res) => {
  const date = req.query.date ? ee.Date(req.query.date) : ee.Date(Date.now());
  const range = parseInt(req.query.range) || 90;
const startDate = date.advance(-range, 'day');
  const endDate = date;

  const chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
    .filterBounds(wards)
    .filterDate(startDate, endDate)
    .select('precipitation');

  const totalRain = chirps.sum().rename('Rainfall_90d').clip(wards);

  serveTile(totalRain, {
    min: 0,
    max: 300,
    palette: ['#e0f3f8', '#abd9e9', '#74add1', '#4575b4', '#313695']
  }, res);
});

app.get('/rainfall-anomaly', (req, res) => {
  const date = req.query.date ? ee.Date(req.query.date) : ee.Date(Date.now());
  const past = date.advance(-1, 'year');
  const range = parseInt(req.query.range) || 90;
const startNow = date.advance(-range, 'day');
const startPast = past.advance(-range, 'day');


  const chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
    .filterBounds(wards)
    .select('precipitation');

  const rainfallNow = chirps.filterDate(startNow, date).sum();
  const rainfallPast = chirps.filterDate(startPast, past).sum();
  const anomaly = rainfallNow.subtract(rainfallPast).rename('Rainfall_Anomaly').clip(wards);

  serveTile(anomaly, {
    min: -50,
    max: 50,
    palette: ['#d73027', '#fee08b', '#1a9850']
  }, res);
});

app.get('/wards', async (req, res) => {
  try {
    const now = ee.Date(Date.now()).advance(-10, 'day'); // buffer
    const oneYearAgo = now.advance(-1, 'year');

    const startNDVI = now.advance(-120, 'day');
    const rainRange = parseInt(req.query.range) || 30;
const startRain = now.advance(-rainRange, 'day');
const startRainPast = oneYearAgo.advance(-rainRange, 'day');
    const startNDVIPast = oneYearAgo.advance(-120, 'day');

    // ✅ NDVI Current & Past
    const s2_now = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(wards).filterDate(startNDVI, now)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .select(['B4', 'B8']);
    const ndvi_now = s2_now.median().normalizedDifference(['B8', 'B4']).rename('NDVI');

    const s2_past = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(wards).filterDate(startNDVIPast, oneYearAgo)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .select(['B4', 'B8']);
    const ndvi_past = s2_past.median().normalizedDifference(['B8', 'B4']).rename('NDVI_PAST');

    // ✅ LST
    const lst = ee.ImageCollection('MODIS/061/MOD11A1')
      .filterBounds(wards).filterDate(startNDVI, now)
      .select('LST_Day_1km')
      .mean().multiply(0.02).subtract(273.15).rename('LST_C');

    // ✅ Rainfall Current & Past
    const chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
      .filterBounds(wards).select('precipitation');
    const rain_now = chirps.filterDate(startRain, now).sum().rename('Rain_Current');
    const rain_past = chirps.filterDate(startRainPast, oneYearAgo).sum().rename('Rain_Past');
    const rain_anomaly = rain_now.subtract(rain_past).rename('Rain_Anomaly');

    const combined = ndvi_now
      .addBands(ndvi_past)
      .addBands(lst)
      .addBands(rain_now)
      .addBands(rain_past)
      .addBands(rain_anomaly);

    const results = combined.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean(),
      scale: 500,
    }).map(f => f.set({
      ndvi: f.get('NDVI'),
      ndvi_past: f.get('NDVI_PAST'),
      lst: f.get('LST_C'),
      rain_mm: f.get('Rain_Current'),
      rain_past: f.get('Rain_Past'),
      anomaly_mm: f.get('Rain_Anomaly')
    }));

    results.getInfo((data, err) => {
      if (err) {
        console.error('❌ Wards API error:', err);
        return res.status(500).json({ error: 'Failed to compute ward stats', details: err });
      }
      res.json(data);
    });

  } catch (error) {
    console.error('❌ Server error:', error);
    res.status(500).json({ error: 'Server error', details: error });
  }
});

app.get('/trend', (req, res) => {
  try {
    const start = ee.Date(Date.now()).advance(-1, 'year');
    const months = ee.List.sequence(0, 11);
    const wardName = req.query.ward;

    const geometry = wardName
      ? wards.filter(ee.Filter.eq('NAME_3', wardName)).geometry()
      : wards.geometry();

    const s2Base = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(geometry)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
      .select(['B4', 'B8']);

    const chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
      .filterBounds(geometry)
      .select('precipitation');

    const monthlyStats = ee.FeatureCollection(months.map(i => {
      const monthStart = start.advance(i, 'month');
      const monthEnd = monthStart.advance(1, 'month');

      const s2 = s2Base.filterDate(monthStart, monthEnd);
      const rain = chirps.filterDate(monthStart, monthEnd).sum().rename('Rain');

      const ndvi = ee.Algorithms.If(
        s2.size().gt(0),
        s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
        ee.Image(ee.Number(0)).updateMask(ee.Image(0)).rename('NDVI') // ✅ masked image
      );

      const combined = ee.Image(ndvi).addBands(rain);

      const stats = combined.reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry,
        scale: 500,
        maxPixels: 1e9
      });

      return ee.Feature(null, stats.set('date', monthStart.format('YYYY-MM')));
    }));

    monthlyStats.getInfo((data, err) => {
      if (err) {
        console.error('❌ Trend API error:', err);
        return res.status(500).json({ error: 'Trend API error', details: err.message || err });
      }

      if (!data || !Array.isArray(data.features)) {
        console.error('❌ Invalid trend data returned');
        return res.status(500).json({ error: 'Invalid data structure returned from Earth Engine' });
      }

      const formatted = data.features.map(f => ({
        date: f.properties.date,
        ndvi: f.properties.NDVI ?? null,
        rain: f.properties.Rain ?? null
      }));

      res.json(formatted);
    });

  } catch (err) {
    console.error('❌ Trend fatal error:', err);
    res.status(500).json({ error: 'Trend route failed', details: err.message || err });
  }
});


  app.get('/', (req, res) => {
    res.send('🌍 GreenMap EE backend is running');
  });
  app.listen(PORT, () => {
    console.log(`🚀 Backend running at http://localhost:${PORT}`);
  });
}
