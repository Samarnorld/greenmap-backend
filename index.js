const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;


// ✅ Use the secret file from Render
const privateKeyPath = '/etc/secrets/ee-key.json';
process.env.GOOGLE_APPLICATION_CREDENTIALS = privateKeyPath;
const privateKey = JSON.parse(fs.readFileSync(privateKeyPath, 'utf8'));

ee.data.authenticateViaPrivateKey(
  privateKey,
  () => {
    ee.initialize(null, null, () => {
      console.log('✅ Earth Engine authenticated via secret file');
      startServer(); // <== make sure this exists below
    });
  },
  (err) => {
    console.error('❌ EE auth failed:', err);
  }
);

function startServer() {
  const wards = ee.FeatureCollection("projects/greenmap-backend/assets/nairobi_wards_filtered");
  function getNDVI(start, end) {
  // Sentinel-2 collection
  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(start, end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
    .select(['B4', 'B8']);

  // Landsat-7 collection
  const landsat = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
    .filterBounds(wards)
    .filterDate(start, end)
    .filter(ee.Filter.lt('CLOUD_COVER', 10))
    .select(['SR_B4', 'SR_B5'])
    .map(img =>
      img
        .multiply(0.0000275)
        .add(-0.2)
        .copyProperties(img, img.propertyNames())
    );

  // Compute NDVI for each
  const sentinelNDVI = s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI');
  const landsatNDVI = landsat.median().normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');

  // A zero-image *with valid pixels* as ultimate fallback
  const fallback = ee.Image.constant(0).rename('NDVI').clip(wards).unmask(0);

  // Decide which to use: Sentinel for dates ≥2015, otherwise Landsat
  const year = end.get('year');
  const ndviImage = ee.Algorithms.If(
    ee.Number(year).gte(2015),
    ee.Algorithms.If(s2.size().gt(0), sentinelNDVI, landsatNDVI),  // if Sentinel empty, try Landsat
    ee.Algorithms.If(landsat.size().gt(0), landsatNDVI, sentinelNDVI)
  );

  // Ensure you always get a real Image
  return ee.Image(ndviImage).unmask(0);
}

app.use(cors());
function serveTile(image, visParams, res) {
  const styled = image.visualize(visParams).clip(wards);

  styled.getMap({}, (map, err) => {
    if (err || !map || !map.urlFormat) {
      console.error("🛑 serveTile failed:", err || 'Missing urlFormat');
      return res.status(500).json({ error: 'Tile rendering failed', details: err });
    }

    console.log("✅ Tile URL generated:", map.urlFormat);
    res.setHeader('Cache-Control', 'public, max-age=3600');
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
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
    .select(['B4', 'B8']);

  const ndvi = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
   ee.Image.constant(0).rename('NDVI').updateMask(ee.Image(0)).clip(wards)
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
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
    .select(['B4', 'B8']);

  const ndvi = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
    ee.Image.constant(0).rename('NDVI').updateMask(ee.Image(0)) // fully transparent fallback
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
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
      .select(['B4', 'B8']);

    const landsat = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
      .filterBounds(wards)
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUD_COVER', 10))
      .select(['SR_B4', 'SR_B5'])
      .map(img => img.multiply(0.0000275).add(-0.2).copyProperties(img, img.propertyNames()));

    const useSentinel = year.gte(2015);

    const ndvi = ee.Algorithms.If(
      useSentinel,
      ee.Algorithms.If(
        sentinel.size().gt(0),
        sentinel.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
       ee.Image.constant(0).rename('NDVI').updateMask(ee.Image(0))

      ),
      ee.Algorithms.If(
        landsat.size().gt(0),
        landsat.median().normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI'),
       ee.Image.constant(0).rename('NDVI').updateMask(ee.Image(0))

      )
    );

    return ee.Image(ndvi);
  }


  const currentNDVI = getNDVI(currentDate);
  const pastNDVI = getNDVI(pastDate);
  const anomaly = ee.Image(currentNDVI).rename('NOW')
  .subtract(ee.Image(pastNDVI).rename('PAST'))
  .rename('NDVI_Anomaly');
anomaly.getInfo((imgInfo, err) => {
  if (err) {
    console.error("❌ Failed to compute NDVI anomaly image:", err);
  } else {
    console.log("✅ NDVI anomaly computed, proceeding to tile generation.");
  }
});

  serveTile(anomaly, {
    min: -0.4,
    max: 0.4,
    palette: ['#d7191c', '#ffffbf', '#1a9641']
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
app.get('/builtup', (req, res) => {
  console.log("📡 /builtup endpoint hit");

  const currentDate = req.query.date ? ee.Date(req.query.date) : ee.Date(Date.now());
  const pastDate = currentDate.advance(-1, 'year');

  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(pastDate, currentDate)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20));

  const safeImage = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().clip(wards),
    ee.Image(0).updateMask(ee.Image(0)).clip(wards) // fully transparent fallback
  );

  const image = ee.Image(safeImage);
  const swir = image.select('B11');
  const nir = image.select('B8');
  const red = image.select('B4');

  const ndbi = swir.subtract(nir).divide(swir.add(nir)).rename('NDBI');
  const ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI');

  const builtMask = ndbi.gt(0).and(ndvi.lt(0.3)).selfMask();

  serveTile(builtMask, {
  min: 0,
  max: 1,
  palette: ['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15']  // 🔴 RED URBAN GRADIENT
}, res);

});
app.get('/builtup-stats', (req, res) => {
  console.log("📊 /builtup-stats called");

  const currentDate = ee.Date(Date.now());
  const pastDate = currentDate.advance(-1, 'year');

  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(pastDate, currentDate)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20));

  const safeImage = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().clip(wards),
    ee.Image(0).updateMask(ee.Image(0)).clip(wards)
  );

  const image = ee.Image(safeImage);
  const swir = image.select('B11');
  const nir = image.select('B8');
  const red = image.select('B4');

  const ndbi = swir.subtract(nir).divide(swir.add(nir)).rename('NDBI');
  const ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI');
 const pixelArea = ee.Image.pixelArea();
 const greenMask = ndvi.gt(0.3); // healthy vegetation
const builtMask = ndbi.gt(0).and(ndvi.lte(0.3)).and(greenMask.not()).selfMask();
const overlap = greenMask.and(builtMask).selfMask();
const overlapArea = overlap.multiply(pixelArea).reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: wards.geometry(),
  scale: 10,
  maxPixels: 1e13
});

overlapArea.getInfo((overlapRes, err) => {
  if (err) {
    console.error("❌ Overlap check failed:", err);
  } else {
    const m2 = overlapRes['NDVI'] || overlapRes['constant'] || 0;
    console.log(`⚠️ Overlapping green+built area: ${(m2 / 1e6).toFixed(2)} km²`);
  }
});

 
  const builtAreaImage = builtMask.multiply(pixelArea).rename('built_m2');

  const builtPerWard = builtAreaImage.reduceRegions({
    collection: wards,
    reducer: ee.Reducer.sum(),
    scale: 10
  }).map(f => {
    const wardArea = f.geometry().area();
    const built_m2 = ee.Number(f.get('sum'));
    const built_pct = built_m2.divide(wardArea).multiply(100);
    return f.set({
      built_m2,
      ward_area_m2: wardArea,
      built_pct
    });
  });

  const totalBuilt = builtAreaImage.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  const totalArea = pixelArea.clip(wards).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  builtPerWard.getInfo((wardStats, err1) => {
    if (err1) {
      console.error('❌ Built-up ward stats error:', err1);
      return res.status(500).json({ error: 'Failed to compute built-up per ward', details: err1 });
    }

    totalBuilt.getInfo((builtRes, err2) => {
      if (err2) {
        console.error('❌ Built-up total error:', err2);
        return res.status(500).json({ error: 'Failed to compute total built-up area', details: err2 });
      }

     totalArea.getInfo((areaRes, err3) => {
  if (err3) {
    console.error('❌ Total area error:', err3);
    return res.status(500).json({ error: 'Failed to compute total Nairobi area', details: err3 });
  }

  const built_m2 = builtRes['built_m2'];
  const total_m2 = areaRes['area'];
  const built_pct = (built_m2 / total_m2) * 100;

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    updated: new Date().toISOString(),
    city_built_m2: built_m2,
    city_total_m2: total_m2,
    city_built_pct: built_pct,
    per_ward: (wardStats.features || []).map(w => ({
      ward: w.properties.wards || w.properties.NAME_3 || 'Unknown',
      built_m2: w.properties.built_m2,
      ward_area_m2: w.properties.ward_area_m2,
      built_pct: w.properties.built_pct
    }))
  });
});
}); 
  });
});
app.get('/wards', (req, res) => {
  const now = ee.Date(Date.now()).advance(-30, 'day');
  const oneYearAgo = now.advance(-1, 'year');

  const startNDVI = now.advance(-120, 'day');
  const startNDVIPast = oneYearAgo.advance(-120, 'day');

  const rainRange = parseInt(req.query.range) || 30;
  const startRain = now.advance(-rainRange, 'day');
  const startRainPast = oneYearAgo.advance(-rainRange, 'day');

  const ndvi_now = getNDVI(startNDVI, now).rename('NDVI_NOW');
  const ndvi_past = getNDVI(startNDVIPast, oneYearAgo).rename('NDVI_PAST');

  const lst = ee.ImageCollection('MODIS/061/MOD11A1')
    .filterBounds(wards)
    .filterDate(startNDVI, now)
    .select('LST_Day_1km')
    .mean()
    .multiply(0.02)
    .subtract(273.15)
    .rename('LST_C');

  const chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
    .filterBounds(wards)
    .select('precipitation');

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
    scale: 1000,
  });

  results.getInfo((data, err) => {
    if (err) {
      console.error("❌ /wards error:", err);
      return res.status(500).json({ error: 'Failed to compute ward stats', details: err });
    }

    console.log("✅ /wards returned features:", data?.features?.length);
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.json(data);
  });
});
app.get('/greencoverage', (req, res) => {
  console.log("🌿 /greencoverage called");

  const now = ee.Date(Date.now());
  const start = now.advance(-120, 'day');
  const ndvi = getNDVI(start, now);

  const greenMask = ndvi.gt(0.3).selfMask();  // healthy NDVI
  const pixelArea = ee.Image.pixelArea();
  const greenArea = greenMask.multiply(pixelArea).rename('green_m2');

  const totalGreen = greenArea.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  const totalArea = pixelArea.clip(wards).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  totalGreen.getInfo((greenRes, err1) => {
    if (err1) {
      console.error("❌ Green cover error:", err1);
      return res.status(500).json({ error: 'Failed to compute green area' });
    }

    totalArea.getInfo((areaRes, err2) => {
      if (err2) {
        console.error("❌ Total area error:", err2);
        return res.status(500).json({ error: 'Failed to compute area' });
      }

      const green_m2 = greenRes['green_m2'] || 0;
      const total_m2 = areaRes['area'] || 1;
      const green_pct = (green_m2 / total_m2) * 100;

      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.json({
        updated: new Date().toISOString(),
        city_green_m2: green_m2,
        city_total_m2: total_m2,
        city_green_pct: green_pct
      });
    });
  });
});
app.get('/treecanopy-stats', (req, res) => {
  const now = ee.Date(Date.now());
  const start = now.advance(-120, 'day');
  const ndvi = getNDVI(start, now);
  const treeMask = ndvi.gt(0.6).selfMask();

  const pixelArea = ee.Image.pixelArea();
  const treeArea = treeMask.multiply(pixelArea).rename('tree_m2');

  const totalTree = treeArea.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  const totalArea = pixelArea.clip(wards).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  totalTree.getInfo((treeRes, err1) => {
    if (err1) {
      console.error("❌ Tree area error:", err1);
      return res.status(500).json({ error: 'Failed to compute tree area' });
    }

    totalArea.getInfo((areaRes, err2) => {
      if (err2) {
        console.error("❌ Area error:", err2);
        return res.status(500).json({ error: 'Failed to compute area' });
      }

      const tree_m2 = treeRes?.['tree_m2'] ?? 0;
      const total_m2 = areaRes?.['area'] ?? 1;
      const tree_pct = (tree_m2 / total_m2) * 100;

      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.json({
        updated: new Date().toISOString(),
        city_tree_m2: tree_m2,
        city_total_m2: total_m2,
        city_tree_pct: tree_pct
      });
    });
  });
});
app.get('/treecanopy', (req, res) => {
  const end = ee.Date(Date.now());
  const start = end.advance(-120, 'day');

  const ndvi = getNDVI(start, end);
  const treeMask = ndvi.gt(0.6).selfMask();

  serveTile(treeMask, {
    min: 0,
    max: 1,
    palette: ['#238b45']
  }, res);
});
app.get('/trend', (req, res) => {
  try {
    const start = ee.Date(Date.now()).advance(-1, 'year');
    const months = ee.List.sequence(0, 11);
    const wardName = req.query.ward;

    const normalizedWard = wardName ? wardName.trim().toLowerCase() : null;

    const geometry = normalizedWard
      ? wards.filter(ee.Filter.eq('NAME_3', ee.String(wardName).capitalize())).first().geometry()
      : wards.geometry();

    // 🛰 Satellite sources
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
        ee.Image(ee.Number(0)).updateMask(ee.Image(0)).rename('NDVI')
      );

      const combined = ee.Image(ndvi).addBands(rain);

      const stats = combined.reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: geometry,
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
        ndvi: f.properties.NDVI || 0,
        rain: f.properties.Rain || 0
      })).filter(d => d.date); // Filter out any without a date

      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.json(formatted);
    });
  } catch (e) {
    console.error('❌ Unhandled error in /trend:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/', (req, res) => {
  res.send('✅ GreenMap Earth Engine backend is live');
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
}