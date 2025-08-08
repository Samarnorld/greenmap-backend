const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const fs = require('fs');

const app = express();
app.use(cors({
  origin: '*'
}));
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
      // 🌍 Warm-up Earth Engine to avoid TLS delays on first request
(async () => {
  try {
    console.log("🌍 Warming up Earth Engine...");
    const warmupImg = ee.Image("COPERNICUS/S2_SR/20220101T083601_20220101T083602_T36MYF")
      .reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: ee.Geometry.Point(36.8219, -1.2921), // Nairobi
        scale: 10,
        maxPixels: 1e9
      });
    const result = await warmupImg.getInfo();
    console.log("✅ EE warm-up complete:", result);
  } catch (err) {
    console.error("⚠️ EE warm-up failed:", err.message);
  }
})();
      startServer(); // <== make sure this exists below
    });
  },
  (err) => {
    console.error('❌ EE auth failed:', err);
  }
);

// 📌 Retry helper for Earth Engine getInfo calls
async function withRetry(eeObject, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await eeObject.getInfo();
    } catch (err) {
      console.warn(`⚠️ Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs));
        console.log(`🔄 Retrying Earth Engine request (Attempt ${attempt + 1})...`);
      } else {
        throw err; // Out of retries
      }
    }
  }
}

function startServer() {
  const wards = ee.FeatureCollection("projects/greenmap-backend/assets/nairobi_wards_filtered");
  function getWardGeometryByName(wardName) {
  const normalized = wardName.trim().toLowerCase();
  return wards.filter(ee.Filter.eq('NAME_3', ee.String(normalized).capitalize())).first().geometry();
}
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
 return ee.Image(ndviImage).unmask(0).clip(wards);
}


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

  const geometry = req.query.ward ? getWardGeometryByName(req.query.ward) : wards.geometry();
const ndviClipped = ee.Image(ndvi).clip(geometry);
serveTile(ndviClipped, {
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
let currentDate, pastDate;

if (req.query.year) {
  const y = parseInt(req.query.year);
  pastDate = ee.Date.fromYMD(y, 1, 1);
  currentDate = ee.Date.fromYMD(y, 12, 31);
} else {
  currentDate = ee.Date(Date.now());
  pastDate = currentDate.advance(-1, 'year');
}


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

 const geometry = req.query.ward ? getWardGeometryByName(req.query.ward) : wards.geometry();
const builtClipped = builtMask.clip(geometry);
serveTile(builtClipped, {
  min: 0,
  max: 1,
  palette: ['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15']  // 🔴 RED URBAN GRADIENT
}, res);

});
app.get('/builtup-stats', (req, res) => {
  console.log("📊 /builtup-stats called");
  let currentDate, pastDate;

  if (req.query.year) {
    const y = parseInt(req.query.year);
    pastDate = ee.Date.fromYMD(y, 1, 1);
    currentDate = ee.Date.fromYMD(y, 12, 31);
  } else {
    currentDate = ee.Date(Date.now());
    pastDate = currentDate.advance(-1, 'year');
  }

  const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(wards)
    .filterDate(pastDate, currentDate)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10));

  const safeImage = ee.Algorithms.If(
    s2.size().gt(0),
    s2.median().clip(wards),
    ee.Image.constant(0).updateMask(ee.Image.constant(0)).clip(wards)
  );

  const image = ee.Image(safeImage);
  const swir = image.select('B11');
  const nir = image.select('B8');
  const red = image.select('B4');

  const ndbi = swir.subtract(nir).divide(swir.add(nir)).rename('NDBI');
  const ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI');

  const pixelArea = ee.Image.pixelArea();
  const greenMask = ndvi.gt(0.3);
  const builtMask = ndbi.gt(0).and(ndvi.lte(0.3)).and(greenMask.not()).selfMask();

  // Overlap (built and green) area just for diagnostics
  const overlap = greenMask.and(builtMask).selfMask();
  const overlapAreaImage = overlap.multiply(pixelArea).rename('overlap_m2');
  const overlapArea = overlapAreaImage.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  overlapArea.getInfo((overlapRes, err) => {
    if (err) {
      console.error("❌ Overlap check failed:", err);
    } else {
      const m2 = overlapRes['overlap_m2'] || 0;
      console.log(`⚠️ Overlapping green+built area: ${(m2 / 1e6).toFixed(2)} km²`);
    }
  });

  const builtAreaImage = builtMask.multiply(pixelArea).rename('built_m2');

  const builtPerWard = builtAreaImage.reduceRegions({
    collection: wards,
    reducer: ee.Reducer.sum(),
    scale: 10
  }).map(f => {
    const wardArea = f.geometry().area(10); // accurate ward area in m²
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

  const totalArea = pixelArea.rename('area').clip(wards).reduceRegion({
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

        if (res.headersSent) return;

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

app.get('/wards', async (req, res) => {

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

 const pixelArea = ee.Image.pixelArea();

// Reduce NDVI and other stats per ward
const results = wards.map(function (ward) {
  const geom = ward.geometry();

  const ndvi_now_mean = ndvi_now.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 10,
    maxPixels: 1e13
  }).get('NDVI_NOW');

  const ndvi_past_mean = ndvi_past.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 10,
    maxPixels: 1e13
  }).get('NDVI_PAST');

  const lst_mean = lst.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 1000,
    maxPixels: 1e13
  }).get('LST_C');

  const rain_now_total = rain_now.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: geom,
    scale: 5000,
    maxPixels: 1e13
  }).get('Rain_Current');

  const rain_past_total = rain_past.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: geom,
    scale: 5000,
    maxPixels: 1e13
  }).get('Rain_Past');

  const rain_anomaly_val = rain_anomaly.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 5000,
    maxPixels: 1e13
  }).get('Rain_Anomaly');

  return ward.set({
    'NDVI_NOW': ndvi_now_mean,
    'NDVI_PAST': ndvi_past_mean,
    'LST_C': lst_mean,
    'Rain_Current': rain_now_total,
    'Rain_Past': rain_past_total,
    'Rain_Anomaly': rain_anomaly_val
  });
});
try {
  const data = await withRetry(results, 3, 2000); // Retry up to 3 times with 2s delay
  console.log("✅ /wards returned features:", data?.features?.length);
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.json(data);
} catch (err) {
  console.error("❌ /wards error:", err);
  res.status(500).json({ error: 'Failed to compute ward stats', details: err.message });
}

});
app.get('/greencoverage', (req, res) => {
  console.log("🌿 /greencoverage called");

  const now = ee.Date(Date.now());
  const start = now.advance(-120, 'day');
  const ndvi = getNDVI(start, now);

  const greenMask = ndvi.gt(0.3).selfMask(); // You can tweak threshold here
  const pixelArea = ee.Image.pixelArea();

  const greenArea = greenMask.multiply(pixelArea).rename('green_m2');

  const totalArea = pixelArea.rename('total_m2').clip(wards);

  const greenStats = greenArea.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  const totalStats = totalArea.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  greenStats.getInfo((greenRes, err1) => {
    if (err1) {
      console.error("❌ Green cover error:", err1);
      return res.status(500).json({ error: 'Failed to compute green area' });
    }

    totalStats.getInfo((areaRes, err2) => {
      if (err2) {
        console.error("❌ Total area error:", err2);
        return res.status(500).json({ error: 'Failed to compute area' });
      }

      const green_m2 = greenRes['green_m2'] || 0;
      const total_m2 = areaRes['total_m2'] || 1;
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
app.get('/treecoverage', (req, res) => {
  const geometry = req.query.ward
    ? getWardGeometryByName(req.query.ward)
    : wards.geometry();

  const year = parseInt(req.query.year) || new Date().getFullYear();
  const start = ee.Date.fromYMD(year, 1, 1);
  const end = start.advance(1, 'year');

  const dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(geometry)
    .filterDate(start, end)
    .select('label');

  const treeMask = dw.mode().eq(1).selfMask(); // Class 1 = Trees

  serveTile(treeMask, {
    min: 0,
    max: 1,
    palette: ['#d9f0d3', '#1a9850'] // light to dark green
  }, res);
});

app.get('/treecanopy-stats', async (req, res) => {
  try {
    const geometry = wards.geometry();
    const pixelArea = ee.Image.pixelArea();

    // === 1. Quick ESA Tree Cover ===
    const esa = ee.ImageCollection("ESA/WorldCover/v100").first().select('Map');
    const treeMaskESA = esa.eq(10).selfMask(); // Class 10 = Trees
    const treeAreaESA = treeMaskESA.multiply(pixelArea).rename('tree_m2');

    const [esaTreeInfo, esaTotalInfo] = await Promise.all([
      treeAreaESA.reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry,
        scale: 10,
        maxPixels: 1e13
      }).getInfo(),
      pixelArea.clip(geometry).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry,
        scale: 10,
        maxPixels: 1e13
      }).getInfo()
    ]);

    const esa_m2 = esaTreeInfo?.tree_m2 ?? 0;
    const esa_total_m2 = esaTotalInfo?.area ?? 1;
    const esa_tree_pct = (esa_m2 / esa_total_m2) * 100;

    // === 2. Dynamic World Tree Trend: City + Wards (2020 → latest year) ===
    const dwCollection = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
      .filterBounds(geometry)
      .select('label');

    const currentYear = new Date().getFullYear();
    const yearsList = ee.List.sequence(2020, currentYear);
    const yearList = await yearsList.getInfo();

    const trend = [];
    for (const y of yearList) {
  const start = ee.Date.fromYMD(y, 1, 1);
  const end = start.advance(1, 'year');

  try {
    const dwImg = dwCollection.filterDate(start, end).mode();
    const treeMask = dwImg.eq(1).selfMask(); // Class 1 = Trees
    const treeArea = treeMask.multiply(pixelArea).rename('tree_m2');

    // City-level tree coverage
    const [cityTreeInfo, cityTotalInfo] = await Promise.all([
      treeArea.reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry,
        scale: 10,
        maxPixels: 1e13
      }).getInfo(),
      pixelArea.clip(geometry).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry,
        scale: 10,
        maxPixels: 1e13
      }).getInfo()
    ]);

    const city_tree_m2 = cityTreeInfo?.tree_m2 ?? 0;
    const city_total_m2 = cityTotalInfo?.area ?? 1;
    const city_tree_pct = (city_tree_m2 / city_total_m2) * 100;

    // === Add this ===
    const wardStatsRaw = await treeArea.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.sum(),
      scale: 10
    }).getInfo();

    // Calculate total area per ward using EE pixelArea reducer:
    const totalAreaStats = await pixelArea.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.sum(),
      scale: 10
    }).getInfo();

    const wards_pct = (wardStatsRaw.features || []).map((w, i) => {
  const tree_m2 = w.properties.tree_m2 || 0;
  const total_m2 = totalAreaStats.features[i]?.properties.area || 1; // use EE area
  // Use NAME_3 first because frontend uses that for matching
  const wardName = w.properties.NAME_3 || w.properties.ward || 'Unknown';

  return {
    ward: wardName,
    tree_pct: (tree_m2 / total_m2) * 100
  };
});

    trend.push({
      year: y,
      city_tree_pct,
      wards: wards_pct
    });

  } catch (err) {
    console.warn(`⚠️ Skipping year ${y} due to error:`, err.message);
  }
}

    // ✅ All done
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.json({
      updated: new Date().toISOString(),
      esa_tree_pct,
      trend
    });

  } catch (err) {
    console.error("❌ /treecanopy-stats error:", err);
    res.status(500).json({ error: 'Tree canopy trend stats failed', details: err.message });
  }
});
const fetch = require('node-fetch'); // if you don't have it, install with: npm install node-fetch@2

app.get('/treesperwardstat', async (req, res) => {
  try {
    const wardsList = wards.features.map(f => f.properties.NAME_3 || f.properties.ward);

    const currentYear = new Date().getFullYear();

    // Fetch /ward-trend data for each ward in parallel
    const trendPromises = wardsList.map(async (wardName) => {
      try {
        // Adjust URL if needed
        const response = await fetch(`https://greenmap-backend.onrender.com/ward-trend?ward=${encodeURIComponent(wardName)}`);
        if (!response.ok) throw new Error(`Failed to fetch ward-trend for ${wardName}`);
        const json = await response.json();

        // Find latest year data: either currentYear or last available
        const latestEntry = json.trend.find(d => d.year === currentYear) || json.trend[json.trend.length - 1];

        return {
          ward: wardName,
          tree_pct: latestEntry ? latestEntry.tree_pct : 0
        };
      } catch (e) {
        console.warn(`⚠️ Could not get tree_pct for ward ${wardName}:`, e.message);
        return { ward: wardName, tree_pct: 0 };
      }
    });

    const wardsCoverage = await Promise.all(trendPromises);

    res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 minutes cache
    res.json({
      updated: new Date().toISOString(),
      year: currentYear,
      wards: wardsCoverage
    });

  } catch (err) {
    console.error('❌ /treesperwardstat error:', err);
    res.status(500).json({ error: 'Failed to get trees per ward stat', details: err.message });
  }
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
function getWardGeometryByName(name) {
  const wards = ee.FeatureCollection("projects/greenmap-backend/assets/nairobi_wards_filtered")
    .filter(ee.Filter.eq("NAME_3", name));
  return wards.geometry();
}
app.get('/ward-trend', async (req, res) => {
  try {
    const wardName = req.query.ward;
    if (!wardName) {
      return res.status(400).json({ error: 'Missing ?ward= name' });
    }

    const geometry = getWardGeometryByName(wardName);
    if (!geometry) return res.status(400).json({ error: 'Ward geometry not found' });

    const pixelArea = ee.Image.pixelArea();
    const currentYear = new Date().getFullYear();
    const yearsList = ee.List.sequence(2017, currentYear);
    const treeCollection = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').select('label');

    const yearList = await yearsList.getInfo();
    const trend = [];

    for (const y of yearList) {
      const start = ee.Date.fromYMD(y, 1, 1);
      const end = start.advance(1, 'year');

      const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(geometry)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
        .select(['B4', 'B8', 'B11']);

      const landsat = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
        .filterBounds(geometry)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUD_COVER', 10))
        .select(['SR_B4', 'SR_B5', 'SR_B7'])
        .map(img => img.multiply(0.0000275).add(-0.2).copyProperties(img, img.propertyNames()));

      const s2Size = await s2.size().getInfo();

      const medianImage = s2Size > 0 ? s2.median() : landsat.median();
      const img = medianImage.clip(geometry);

      const bandNames = await img.bandNames().getInfo();

      const nirBand = bandNames.includes('B8') ? 'B8' : 'SR_B5';
      const redBand = bandNames.includes('B4') ? 'B4' : 'SR_B4';
      const swirBand = bandNames.includes('B11') ? 'B11' : 'SR_B7';

      const nir = img.select(nirBand);
      const red = img.select(redBand);
      const swir = img.select(swirBand);

      const ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI');
      const ndbi = swir.subtract(nir).divide(swir.add(nir)).rename('NDBI');

      const builtMask = ndbi.gt(0).and(ndvi.lt(0.3)).selfMask();
      const builtArea = builtMask.multiply(pixelArea).rename('built_m2');

      const treeMask = treeCollection
        .filterDate(start, end)
        .mode()
        .eq(1)
        .selfMask();
      const treeArea = treeMask.multiply(pixelArea).rename('tree_m2');

      const totalArea = pixelArea.clip(geometry).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry,
        scale: 10,
        maxPixels: 1e13
      });

      const [ndviMean, builtStats, treeStats, totalStats] = await Promise.all([
        ndvi.reduceRegion({
          reducer: ee.Reducer.mean(),
          geometry,
          scale: 10,
          maxPixels: 1e13
        }).getInfo(),
        builtArea.reduceRegion({
          reducer: ee.Reducer.sum(),
          geometry,
          scale: 10,
          maxPixels: 1e13
        }).getInfo(),
        treeArea.reduceRegion({
          reducer: ee.Reducer.sum(),
          geometry,
          scale: 10,
          maxPixels: 1e13
        }).getInfo(),
        totalArea.getInfo()
      ]);

      const total_m2 = totalStats['area'] || totalStats['sum'] || 1; // check keys here!

      trend.push({
        year: y,
        ndvi: ndviMean.NDVI || 0,
        tree_pct: ((treeStats.tree_m2 || 0) / total_m2) * 100,
        built_pct: ((builtStats.built_m2 || 0) / total_m2) * 100
      });
    }

    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({
      ward: wardName,
      trend,
      updated: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ /ward-trend error:', err);
    res.status(500).json({ error: 'Ward trend error', details: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('✅ GreenMap Earth Engine backend is live');
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
}