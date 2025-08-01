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
app.get('/greencoverage', (req, res) => {
  console.log("🌱 /greencoverage called");

  const now = ee.Date(Date.now());
  const start = now.advance(-120, 'day');

  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(start, now)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
    .select(['B4', 'B8']);

  const ndvi = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
    ee.Image.constant(0).rename('NDVI').updateMask(ee.Image(0))
  );

  const ndviImage = ee.Image(ndvi);
  const greenMask = ndviImage.gt(0.3).selfMask(); // healthy vegetation
  const pixelArea = ee.Image.pixelArea();
  const greenArea = greenMask.multiply(pixelArea).rename('green_m2');

  const overlapWithBuilt = (() => {
    const swir = s2.median().select('B11');
    const nir = s2.median().select('B8');
    const red = s2.median().select('B4');
    const ndbi = swir.subtract(nir).divide(swir.add(nir));
    const ndvi_local = nir.subtract(red).divide(nir.add(red));
    const builtMask = ndbi.gt(0).and(ndvi_local.lte(0.3)).selfMask();
    return greenMask.and(builtMask).selfMask();
  })();

  const overlapArea = overlapWithBuilt.multiply(pixelArea).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

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

  const greenPerWard = greenArea.reduceRegions({
    collection: wards,
    reducer: ee.Reducer.sum(),
    scale: 10
  }).map(f => {
    const wardArea = f.geometry().area();
    const green_m2 = ee.Number(f.get('sum'));
    const green_pct = green_m2.divide(wardArea).multiply(100);
    return f.set({
      green_m2,
      ward_area_m2: wardArea,
      green_pct
    });
  });

  greenPerWard.getInfo((wardStats, err1) => {
    if (err1) {
      console.error('❌ Ward green stats error:', err1);
      return res.status(500).json({ error: 'Failed to compute green per ward', details: err1 });
    }

    totalGreen.getInfo((greenRes, err2) => {
      if (err2) {
        console.error('❌ Total green error:', err2);
        return res.status(500).json({ error: 'Failed to compute total green', details: err2 });
      }

      totalArea.getInfo((areaRes, err3) => {
        if (err3) {
          console.error('❌ Total area error:', err3);
          return res.status(500).json({ error: 'Failed to compute total area', details: err3 });
        }

        overlapArea.getInfo((overlapRes, err4) => {
          const green_m2 = greenRes?.['green_m2'] ?? 0;
const total_m2 = areaRes?.['area'] ?? 1; // avoid divide-by-zero
          const green_pct = (green_m2 / total_m2) * 100;
         const overlap_m2 = overlapRes?.['NDVI'] ?? overlapRes?.['constant'] ?? 0;


          console.log(`✅ Green cover: ${(green_m2 / 1e6).toFixed(2)} km²`);
          console.log(`⚠️ Overlapping green+built area: ${(overlap_m2 / 1e6).toFixed(2)} km²`);
console.log({
  green_m2,
  total_m2,
  green_pct,
  overlap_m2
});

          res.setHeader('Cache-Control', 'public, max-age=1800');
          res.json({
            updated: new Date().toISOString(),
            city_green_m2: green_m2,
            city_total_m2: total_m2,
            city_green_pct: green_pct,
            city_green_built_overlap_m2: overlap_m2,
            per_ward: (wardStats.features || []).map(w => ({
              ward: w.properties.wards || w.properties.NAME_3 || 'Unknown',
              green_m2: w.properties.green_m2,
              ward_area_m2: w.properties.ward_area_m2,
              green_pct: w.properties.green_pct
            }))
          });
        });
      });
    });
  });
});
app.get('/treecanopy', (req, res) => {
  console.log("🌳 /treecanopy called");

  const now = ee.Date(Date.now());
  const start = now.advance(-120, 'day');

  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(start, now)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
    .select(['B4', 'B8']);

  const fallback = ee.Image(0).rename('NDVI').updateMask(ee.Image(0));
  const ndvi = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
    fallback
  );

  const ndviImage = ee.Image(ndvi).clip(wards);
  const treeMask = ndviImage.gt(0.6).selfMask(); // NDVI > 0.6

  serveTile(treeMask, {
    min: 0,
    max: 1,
    palette: ['#238b45']  // dark green
  }, res);
});
app.get('/treecanopy-stats', (req, res) => {
  console.log("📊 /treecanopy-stats called");

  const now = ee.Date(Date.now());
  const start = now.advance(-120, 'day');

  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(start, now)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
    .select(['B4', 'B8']);

  const fallback = ee.Image(0).rename('NDVI').updateMask(ee.Image(0));
  const ndvi = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
    fallback
  );

  const ndviImage = ee.Image(ndvi).clip(wards);
  const treeMask = ndviImage.gt(0.6).selfMask();  // tree threshold

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
      console.error('❌ Tree area error:', err1);
      return res.status(500).json({ error: 'Failed to compute tree area', details: err1 });
    }

    totalArea.getInfo((areaRes, err2) => {
      if (err2) {
        console.error('❌ Total area error:', err2);
        return res.status(500).json({ error: 'Failed to compute total area', details: err2 });
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

app.get('/wards', async (req, res) => {
  try {
    const now = ee.Date(Date.now()).advance(-30, 'day'); 
    const oneYearAgo = now.advance(-1, 'year');

    const startNDVI = now.advance(-120, 'day');
    const rainRange = parseInt(req.query.range) || 30;
const startRain = now.advance(-rainRange, 'day');
const startRainPast = oneYearAgo.advance(-rainRange, 'day');
    const startNDVIPast = oneYearAgo.advance(-120, 'day');

    function getSafeNDVI(start, end) {
  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(start, end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
    .select(['B4', 'B8']);

  return ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().normalizedDifference(['B8', 'B4']).rename('NDVI'),
    ee.Image.constant(0).rename('NDVI').updateMask(ee.Image(0)) // transparent fallback
  );
}

const ndvi_now = ee.Image(getSafeNDVI(startNDVI, now));
const ndvi_past = ee.Image(getSafeNDVI(startNDVIPast, oneYearAgo));
console.log("🛰 Computing NDVI stats...");
console.log("🕐 Current NDVI window:", startNDVI.getInfo(), "→", now.getInfo());
console.log("🕐 Past NDVI window:", startNDVIPast.getInfo(), "→", oneYearAgo.getInfo());

    const lst = ee.ImageCollection('MODIS/061/MOD11A1')
      .filterBounds(wards).filterDate(startNDVI, now)
      .select('LST_Day_1km')
      .mean().multiply(0.02).subtract(273.15).rename('LST_C');

    const chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
      .filterBounds(wards).select('precipitation');
    const rain_now = chirps.filterDate(startRain, now).sum().rename('Rain_Current');
    const rain_past = chirps.filterDate(startRainPast, oneYearAgo).sum().rename('Rain_Past');
    const rain_anomaly = rain_now.subtract(rain_past).rename('Rain_Anomaly');

   const combined = ndvi_now.rename('NDVI_NOW')
  .addBands(ndvi_past.rename('NDVI_PAST'))
  .addBands(lst)
  .addBands(rain_now)
  .addBands(rain_past)
  .addBands(rain_anomaly);
console.log("📦 Combined bands added, now reducing regions...");

const results = combined.reduceRegions({
  collection: wards,
  reducer: ee.Reducer.mean(),
  scale: 1000,
    }).map(f => f.set({
  ndvi: f.get('NDVI_NOW'),
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
      res.setHeader('Cache-Control', 'public, max-age=900');
console.log("✅ Sample ward NDVI result:", data?.features?.[0]?.properties);

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

    const normalizedWard = wardName ? wardName.trim().toLowerCase() : null;

    const geometry = normalizedWard
      ? wards.filter(ee.Filter.eq('NAME_3', wardName)).geometry()
      : wards.geometry();

    if (normalizedWard) {
      wards.filter(ee.Filter.eq('NAME_3', wardName)).size().getInfo((count) => {
        console.log(`✅ Matching features for "${wardName}":`, count);
      });
    } else {
      console.log("📊 No ward selected — loading whole Nairobi.");
    }

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
