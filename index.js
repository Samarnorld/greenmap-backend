const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const fs = require('fs');

const app = express();
app.use(cors({
  origin: '*'
}));
const PORT = process.env.PORT || 3000;
process.env.TZ = 'Africa/Nairobi';

// ---------- PRECOMPUTE SCHEDULER + CACHE (paste here) ----------
const cron = require('node-cron');

// endpoints we want to precompute (keep leading slashes)
const PRECOMP_ENDPOINTS = [
  '/wards',
  '/indicators',
  '/greencoverage',
  '/treecanopy-stats',
  '/wardsstatstree',
  '/builtup-stats',
  '/builtup-stats-dw',
  '/most-deforested',
  `/charttrend?startYear=2020&endYear=${new Date().getFullYear()}`
];

const precomputed = {}; // in-memory cache for JSON results
// ----------------------------------------------------------------


// ✅ Use the secret file from Render
const privateKeyPath = '/etc/secrets/ee-key.json';
process.env.GOOGLE_APPLICATION_CREDENTIALS = privateKeyPath;
const privateKey = JSON.parse(fs.readFileSync(privateKeyPath, 'utf8'));

ee.data.authenticateViaPrivateKey(
  privateKey,
  () => {
    ee.initialize(null, null, async () => {
      console.log('✅ Earth Engine authenticated via secret file');
      // 🌍 Warm-up Earth Engine to avoid TLS delays on first request
      try {
        console.log("🌍 Warming up Earth Engine...");
        const warmupImg = ee.Image("COPERNICUS/S2_SR/20220101T083601_20220101T083602_T36MYF")
          .reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: ee.Geometry.Point(36.8219, -1.2921), // Nairobi coordinates
            scale: 10,
            maxPixels: 1e9
          });
        const result = await warmupImg.getInfo();
        console.log("✅ EE warm-up complete:", result);
      } catch (err) {
        console.error("⚠️ EE warm-up failed:", err.message || err);
      }

      startServer(); // Start your Express server after EE is warmed up
    });
  },
  (err) => {
    console.error('❌ EE auth failed:', err);
  }
);

// Timeout wrapper for Promises
function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms} ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// Retry helper for Earth Engine getInfo calls with timeout
async function withRetry(eeObject, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await withTimeout(eeObject.getInfo(), 30000); // 30 sec timeout
    } catch (err) {
      console.warn(`⚠️ Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs));
        console.log(`🔄 Retrying Earth Engine request (Attempt ${attempt + 1})...`);
      } else {
        throw err;
      }
    }
  }
}



function startServer() {
  const wards = ee.FeatureCollection("projects/greenmap-backend/assets/nairobi_wards_filtered");
  function getWardGeometryByName(wardName) {
    if (!wardName) return null;
    const normalized = wardName.trim();
    return wards.filter(ee.Filter.eq('NAME_3', normalized)).first().geometry();
  }

function getNDVI(startDate, endDate) {
  // Returns a single-band ee.Image named 'NDVI' computed as the 50th percentile
  // of cloud/shadow-masked Sentinel-2 NDVI over the provided window.
  var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterDate(startDate, endDate)
    .filterBounds(wards)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80))
    .map(function(img) {
      var scl = img.select('SCL');
      var mask = scl.neq(0).and(scl.neq(1))
                   .and(scl.neq(3)).and(scl.neq(8))
                   .and(scl.neq(9)).and(scl.neq(10))
                   .and(scl.neq(11));
      var scaled = img.updateMask(mask).divide(10000);
      // produce an NDVI band named 'NDVI' for each image
      var ndvi = scaled.normalizedDifference(['B8','B4']).rename('NDVI');
      return ndvi.copyProperties(img, ['system:time_start']);
    });

  // Reduce using 50th percentile. The reducer will produce 'NDVI_p50' — rename to 'NDVI'.
  return ee.Image(ee.Algorithms.If(
    s2.size().gt(0),
    s2.reduce(ee.Reducer.percentile([50])).select(['NDVI_p50']).rename('NDVI'),
    // fallback: a fully-masked NDVI image named 'NDVI'
    ee.Image(0).updateMask(ee.Image(0)).rename('NDVI')
  ));
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

  const mask = ee.Image(ndvi).updateMask(ee.Image(ndvi).gt(0.4));

  serveTile(mask, {
    min: 0.4,
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

// place this AFTER you initialise `ee` and after `wards` (ee.FeatureCollection) is defined.
// Put it before app.listen(...) and after your other route handlers (e.g., /indicators).

app.get(['/builtup-stats-dw', '/api/builtup-stats-dw'], async (req, res) => {
  console.log('📡 /builtup-stats-dw called');
  // Allow cross-origin (optionally remove if you enable cors globally)
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (typeof wards === 'undefined' || !wards) {
      console.error('❌ /builtup-stats-dw: wards is not defined in server scope');
      return res.status(500).json({ error: 'Server misconfiguration: wards not defined' });
    }

    // --- time window: either ?year=YYYY or last 12 months ---
    let startDate, endDate;
    if (req.query.year) {
      const y = parseInt(req.query.year, 10);
      if (Number.isFinite(y)) {
        startDate = ee.Date.fromYMD(y, 1, 1);
        endDate = ee.Date.fromYMD(y, 12, 31);
      } else {
        startDate = ee.Date(Date.now()).advance(-1, 'year');
        endDate = ee.Date(Date.now());
      }
    } else {
      endDate = ee.Date(Date.now());
      startDate = endDate.advance(-1, 'year');
    }

    // --- Dynamic World: built probability band ---
    const dwCol = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
      .filterBounds(wards)
      .filterDate(startDate, endDate)
      .select('built'); // 'built' is the fractional probability band (0..1)

    // If no DW images found, fallback to constant 0 image to avoid errors
    const safeBuiltMean = ee.Image(ee.Algorithms.If(dwCol.size().gt(0), dwCol.mean(), ee.Image.constant(0)))
      .clip(wards)
      .rename('built_prob_mean');

    const pixelArea = ee.Image.pixelArea(); // m^2 per pixel

    // expected built area per pixel (probability * pixelArea)
    const builtAreaImg = safeBuiltMean.multiply(pixelArea).rename('built_m2');

    // total built area (sum over city)
    const builtTotalRR = builtAreaImg.reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: wards.geometry(),
      scale: 10,        // Dynamic World is Sentinel-2-based (10m)
      maxPixels: 1e13,
      tileScale: 4
    });

    // total city area
    const totalAreaRR = pixelArea.rename('area').reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: wards.geometry(),
      scale: 10,
      maxPixels: 1e13,
      tileScale: 4
    });

    // per-ward built-up (sum of expected built m2 inside each ward)
    const perWardFC = builtAreaImg.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.sum(),
      scale: 10
    }).map(function (f) {
      // compute ward area accurately on server
      const wardArea = f.geometry().area(10);
      const built_m2 = ee.Number(f.get('sum'));
      const built_pct = ee.Algorithms.If(wardArea.gt(0), built_m2.divide(wardArea).multiply(100), null);
      return f.set({
        built_m2: built_m2,
        ward_area_m2: wardArea,
        built_pct: built_pct
      });
    });

    // Helper to promisify getInfo calls
    const getInfo = (eeObj) => new Promise((resolve, reject) => {
      eeObj.getInfo((result, err) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    // retrieve results in parallel
    const [builtRes, areaRes, perWardRes] = await Promise.all([
      getInfo(builtTotalRR),
      getInfo(totalAreaRR),
      getInfo(perWardFC)
    ]);

    // Extract numeric values safely
    const built_m2 = builtRes && (builtRes.built_m2 || builtRes.sum) ? Number(builtRes.built_m2 || builtRes.sum) : 0;
    const total_m2 = areaRes && (areaRes.area || areaRes.sum) ? Number(areaRes.area || areaRes.sum) : null;
    const city_built_pct = (total_m2 && total_m2 > 0) ? (built_m2 / total_m2) * 100 : null;

    // Build per-ward array; field names will depend on your wards FeatureCollection properties
    const perWardArray = (perWardRes.features || []).map(f => {
      const p = f.properties || {};
      return {
        ward: (p.wards || p.NAME_3 || p.name || p.WARD || 'Unknown'),
        built_m2: p.built_m2 ?? p.sum ?? 0,
        ward_area_m2: p.ward_area_m2 ?? null,
        built_pct: p.built_pct !== undefined && p.built_pct !== null ? Number(Number(p.built_pct).toFixed(3)) : null
      };
    });

    // respond
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
    return res.json({
      updated: new Date().toISOString(),
      method: 'dynamicworld_mean_built',
      period: {
        start: startDate.format('YYYY-MM-dd').getInfo ? startDate.format('YYYY-MM-dd').getInfo() : null,
        end: endDate.format('YYYY-MM-dd').getInfo ? endDate.format('YYYY-MM-dd').getInfo() : null
      },
      city_built_m2: Math.round(built_m2),
      city_total_m2: total_m2 ? Math.round(total_m2) : null,
      city_built_pct: city_built_pct !== null ? Number(city_built_pct.toFixed(3)) : null,
      per_ward: perWardArray
    });

  } catch (err) {
    console.error('❌ /builtup-stats-dw error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to compute built-up stats (Dynamic World)', details: String(err && err.message ? err.message : err) });
  }
});

app.get('/wards', async (req, res) => {

  // Define now and past windows (recent 30 days vs same period last year)
  const now = ee.Date(Date.now()).advance(-30, 'day');
  const oneYearAgo = now.advance(-1, 'year');

  const startNDVI = now.advance(-30, 'day');            // last 30 days
  const startNDVIPast = oneYearAgo.advance(-30, 'day'); // same window last year

  const rainRange = parseInt(req.query.range) || 30;
  const startRain = now.advance(-rainRange, 'day');
  const startRainPast = oneYearAgo.advance(-rainRange, 'day');

  // NDVI images (each has a band named 'NDVI')
  const ndvi_now = getNDVI(startNDVI, now);
  const ndvi_past = getNDVI(startNDVIPast, oneYearAgo);

  // LST (unchanged)
  const lst = ee.ImageCollection('MODIS/061/MOD11A1')
    .filterBounds(wards)
    .filterDate(startNDVI, now)
    .select('LST_Day_1km')
    .mean()
    .multiply(0.02)
    .subtract(273.15)
    .rename('LST_C');

  // Rainfall (unchanged)
  const chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
    .filterBounds(wards)
    .select('precipitation');

  const rain_now = chirps.filterDate(startRain, now).sum().rename('Rain_Current');
  const rain_past = chirps.filterDate(startRainPast, oneYearAgo).sum().rename('Rain_Past');
  const rain_anomaly = rain_now.subtract(rain_past).rename('Rain_Anomaly');

  // Per-ward reduction (use median for NDVI to avoid small green patches skewing the mean)
  const results = wards.map(function(ward) {
    const geom = ward.geometry();

    const ndvi_now_median = ndvi_now.reduceRegion({
      reducer: ee.Reducer.median(),
      geometry: geom,
      scale: 10,
      maxPixels: 1e13
    }).get('NDVI');

    const ndvi_past_median = ndvi_past.reduceRegion({
      reducer: ee.Reducer.median(),
      geometry: geom,
      scale: 10,
      maxPixels: 1e13
    }).get('NDVI');

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

    // Return the ward with consistent property names
    return ward.set({
      'NDVI_NOW': ndvi_now_median,
      'NDVI_PAST': ndvi_past_median,
      'LST_C': lst_mean,
      'Rain_Current': rain_now_total,
      'Rain_Past': rain_past_total,
      'Rain_Anomaly': rain_anomaly_val
    });
  });

  try {
    const data = await withRetry(results, 3, 2000);
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

  // Compute NDVI from Sentinel-2
  const ndvi = getNDVI(start, now);

  // Mask NDVI > 0.3 (considered vegetation)
  const greenMask = ndvi.gt(0.3);

  // Pixel area (m²)
  const pixelArea = ee.Image.pixelArea();

  // Green area (only where NDVI > 0.3)
  const greenArea = greenMask.multiply(pixelArea).rename('green_m2');

  // Total ward area
  const totalArea = pixelArea.clip(wards).rename('total_m2');

  // Reduce to total city green area
  const greenStats = greenArea.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  // Reduce to total city area
  const totalStats = totalArea.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: wards.geometry(),
    scale: 10,
    maxPixels: 1e13
  });

  // Get results
  greenStats.getInfo((greenRes, err1) => {
    if (err1) {
      console.error("❌ Green cover error:", err1);
      return res.status(500).json({ error: 'Failed to compute green area' });
    }

    totalStats.getInfo((areaRes, err2) => {
      if (err2) {
        console.error("❌ Total area error:", err2);
        return res.status(500).json({ error: 'Failed to compute total area' });
      }

      const green_m2 = greenRes['green_m2'] || 0;
      const total_m2 = areaRes['total_m2'] || 1; // prevent divide by zero
      const green_pct = (green_m2 / total_m2) * 100;

      res.setHeader('Cache-Control', 'public, max-age=1800'); // cache 30 mins
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
// GET /charttrend?startYear=2021&endYear=2025
// GET /charttrend?startYear=2021&endYear=2025
app.get('/charttrend', async (req, res) => {
const log = {
  info: (...a) => console.info('[charttrend][INFO]', ...a),
  warn: (...a) => console.warn('[charttrend][WARN]', ...a),
  error: (...a) => console.error('[charttrend][ERROR]', ...a),
};


  const evaluateAsync = (eeObject, timeoutMs = 180000) => new Promise((resolve, reject) => {
    let finished = false;
    try {
      eeObject.evaluate((result, err) => {
        finished = true;
        if (err) {
          log.error('EE evaluate callback error:', err);
          return reject(err);
        }
        return resolve(result);
      });
    } catch (e) {
      finished = true;
      log.error('Exception calling ee.evaluate:', e);
      return reject(e);
    }
    setTimeout(() => {
      if (!finished) {
        const msg = `EE evaluate timed out after ${timeoutMs}ms`;
        log.error(msg);
        reject(new Error(msg));
      }
    }, timeoutMs);
  });

  try {
    log.info('Request received for /charttrend');

    // parse query
    const qStart = parseInt(req.query.startYear, 10);
    const startYear = Number.isFinite(qStart) ? qStart : 2021;
    const qEnd = parseInt(req.query.endYear, 10);
    const endYear = Number.isFinite(qEnd) ? qEnd : new Date().getFullYear();

    // city geometry and helpers
    const wards = ee.FeatureCollection('projects/greenmap-backend/assets/nairobi_wards_filtered');
    const nairobiGeom = wards.union().geometry();
    const totalAreaM2 = ee.Number(nairobiGeom.area());
    const pixelArea = ee.Image.pixelArea();

    // collectors (EE objects / lists)
    const years = [];
    const ndviVals = [];      // MODIS mean NDVI (scaled)
    const treeVals = [];      // DW trees probability (0..1)
    const builtDWVals = [];   // DW built probability (converted to 0..100)
    const rainVals = [];      // CHIRPS

    log.info(`Queueing years ${startYear}..${endYear}`);

    for (let y = startYear; y <= endYear; y++) {
      years.push(y);
      const start = ee.Date.fromYMD(y, 1, 1);
      const end = ee.Date.fromYMD(y, 12, 31);

      // NDVI (MODIS annual mean)
      const ndviImg = ee.ImageCollection('MODIS/061/MOD13Q1')
        .filterDate(start, end)
        .select('NDVI')
        .mean()
        .multiply(0.0001);

      const ndviVal = ndviImg.reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: nairobiGeom,
        scale: 250,
        maxPixels: 1e13,
        tileScale: 4,
        bestEffort: true
      }).get('NDVI');
      ndviVals.push(ndviVal);
      log.info(`NDVI queued for ${y}`);

      // Tree cover (Dynamic World 'trees' probability average across city)
      const dwTreesCol = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
        .filterDate(start, end)
        .filterBounds(nairobiGeom)
        .select('trees');

      const dwTreesMean = ee.Image(ee.Algorithms.If(
        dwTreesCol.size().gt(0),
        dwTreesCol.mean(),
        ee.Image.constant(0).rename('trees')
      )).clip(nairobiGeom);

      const treeFrac = dwTreesMean.reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: nairobiGeom,
        scale: 10,
        maxPixels: 1e13,
        tileScale: 4,
        bestEffort: true
      }).get('trees');
      treeVals.push(treeFrac);
      log.info(`Tree (DW) queued for ${y}`);

      // Built-up (Dynamic World 'built' probability)
      const dwBuiltCol = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
        .filterDate(start, end)
        .filterBounds(nairobiGeom)
        .select('built');

      const dwBuiltMean = ee.Image(ee.Algorithms.If(
        dwBuiltCol.size().gt(0),
        dwBuiltCol.mean(),
        ee.Image.constant(0).rename('built')
      )).clip(nairobiGeom);

      const builtDWMean = dwBuiltMean.reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: nairobiGeom,
        scale: 10,
        maxPixels: 1e13,
        tileScale: 4,
        bestEffort: true
      }).get('built'); // 0..1

      // convert to percent 0..100
      builtDWVals.push(ee.Number(builtDWMean).multiply(100));
      log.info(`Built (DW) queued for ${y}`);

      // Rainfall (CHIRPS annual sum -> mean)
      const rainSumImg = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
        .filterDate(start, end)
        .select('precipitation')
        .sum();

      const rainMean = rainSumImg.reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: nairobiGeom,
        scale: 5000,
        maxPixels: 1e13,
        tileScale: 4,
        bestEffort: true
      }).get('precipitation');

      rainVals.push(rainMean);
      log.info(`Rain queued for ${y}`);
    } // for years

    log.info('Preparing ee.Dictionary and evaluating');
    const allData = ee.Dictionary({
      years: years,
      ndvi: ee.List(ndviVals),
      tree_frac: ee.List(treeVals),        // 0..1
      built_pct_dw: ee.List(builtDWVals), // 0..100
      rainfall: ee.List(rainVals)
    });

    let rawResult;
    try {
      rawResult = await evaluateAsync(allData, 180000);
    } catch (eeErr) {
      log.error('Earth Engine evaluation failed:', eeErr && eeErr.stack ? eeErr.stack : eeErr);
      return res.status(502).json({ error: 'Earth Engine evaluation failed', details: String(eeErr) });
    }

    if (!rawResult) {
      log.error('Empty result from Earth Engine');
      return res.status(502).json({ error: 'Empty result from Earth Engine' });
    }

    // Normalizer
    const normalizeArray = (arr, expectedLen) => {
      if (!Array.isArray(arr)) {
        if (arr !== undefined && arr !== null && typeof arr === 'number') {
          return Array.from({ length: expectedLen }, () => arr);
        }
        return Array.from({ length: expectedLen }, () => null);
      }
      const out = arr.slice(0, expectedLen).map(v => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      });
      while (out.length < expectedLen) out.push(null);
      return out;
    };

    const n = years.length;
    const payload = {
      years: rawResult.years ?? years,
      ndvi: normalizeArray(rawResult.ndvi ?? rawResult.NDVI, n),
      tree_coverage: normalizeArray(rawResult.tree_frac, n).map(v => (v === null ? null : Number((v * 100).toFixed(3)))),
      // Built-up (Dynamic World) as percent 0..100
      built_dw: normalizeArray(rawResult.built_pct_dw, n).map(v => (v === null ? null : Number(Number(v).toFixed(4)))),
      rainfall: normalizeArray(rawResult.rainfall ?? rawResult.precipitation ?? rawResult.rain, n)
    };

    log.info('Returning payload summary:', {
      years_count: payload.years.length || n,
      built_sample: payload.built_dw.slice(0, 3),
      tree_sample: payload.tree_coverage.slice(0, 3)
    });

    return res.json(payload);

  } catch (error) {
    console.error('[charttrend][FATAL] Uncaught error:', error && error.stack ? error.stack : error);
    return res.status(500).json({ error: 'Internal server error generating charttrend', details: String(error) });
  }
});

// Replace the old /most-deforested handler with this block
app.get('/most-deforested', async (req, res) => {
  try {
    console.log("[most-deforested] Calculating...");

    // ---------- Config (overrideable via query params) ----------
    const MIN_LOSS_M2 = Number(req.query.minLossM2) || 1000;   // default 1,000 m²
    const MIN_LOSS_PCT = Number(req.query.minLossPct) || 0.1;  // default 0.1%
    const MIN_PREV_M2 = Number(req.query.minPrevM2) || 1;      // previous-year must have > this many m² to be considered

    // Last full year and previous
    const currentYear = new Date().getFullYear();
    const latestYear = currentYear - 1;
    const prevYear = latestYear - 1;

    const pixelArea = ee.Image.pixelArea();
    const wards = ee.FeatureCollection('projects/greenmap-backend/assets/nairobi_wards_filtered')
      .filter(ee.Filter.notNull(['NAME_3']));

    const dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').select('label');

    const treeMaskForYear = (year) => {
      const start = ee.Date.fromYMD(year, 1, 1);
      const end = start.advance(1, 'year');
      return dw.filterDate(start, end).mode().eq(1); // class==1 => trees
    };

    const latestTreeAreaImg = treeMaskForYear(latestYear).multiply(pixelArea).rename('tree_m2');
    const prevTreeAreaImg = treeMaskForYear(prevYear).multiply(pixelArea).rename('tree_m2');

    const latestPerWard = latestTreeAreaImg.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.sum(),
      scale: 10
    });

    const prevPerWard = prevTreeAreaImg.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.sum(),
      scale: 10
    });

    const totalAreaFc = pixelArea.rename('area').reduceRegions({
      collection: wards,
      reducer: ee.Reducer.sum(),
      scale: 10
    });

    // Evaluate with retries (your helper)
    const [latestInfo, prevInfo, totalInfo] = await Promise.all([
      withRetry(latestPerWard),
      withRetry(prevPerWard),
      withRetry(totalAreaFc)
    ]);

    const normalize = s => (s || '').toString().trim().toLowerCase();

    // Build maps of m² by ward key
    const latestMap = new Map();
    (latestInfo.features || []).forEach(f => {
      const name = f.properties.NAME_3 || f.properties.ward || f.properties.WARD || f.id;
      latestMap.set(normalize(name), Number((f.properties && (f.properties.tree_m2 ?? f.properties.sum)) || 0));
    });

    const prevMap = new Map();
    (prevInfo.features || []).forEach(f => {
      const name = f.properties.NAME_3 || f.properties.ward || f.properties.WARD || f.id;
      prevMap.set(normalize(name), Number((f.properties && (f.properties.tree_m2 ?? f.properties.sum)) || 0));
    });

    // Build wardResults with both absolute and percent metrics
    const wardResults = (totalInfo.features || []).map(f => {
      const name = f.properties.NAME_3 || f.properties.ward || f.properties.WARD || f.id;
      const key = normalize(name);

      const total_m2 = Number(f.properties?.area ?? f.properties?.sum ?? 0) || 0;
      const latest_m2 = latestMap.get(key) || 0;
      const prev_m2 = prevMap.get(key) || 0;

      const latest_pct = total_m2 > 0 ? (latest_m2 / total_m2) * 100 : null;
      const prev_pct = total_m2 > 0 ? (prev_m2 / total_m2) * 100 : null;

      const raw_loss_m2 = (prev_m2 - latest_m2);
      const loss_m2 = raw_loss_m2 > 0 ? raw_loss_m2 : 0;         // never negative
      const loss_pct = (prev_pct !== null && latest_pct !== null) ? (prev_pct - latest_pct) : null;

      return {
        ward: name,
        total_m2,
        latest_m2,
        prev_m2,
        latest_pct,
        prev_pct,
        loss_m2,
        loss_pct
      };
    });

    // ---------- Primary selection: pick by absolute area lost ----------
    // Candidates must have had some previous tree area (prev_m2 >= MIN_PREV_M2) and a positive loss.
    // Also require meeting at least one threshold (area or percent). Primary sort = loss_m2 desc, tiebreaker = loss_pct desc.
    const candidates = wardResults.filter(w =>
      typeof w.loss_m2 === 'number' && isFinite(w.loss_m2) && w.loss_m2 > 0 &&
      typeof w.prev_m2 === 'number' && isFinite(w.prev_m2) && w.prev_m2 >= MIN_PREV_M2 &&
      (w.loss_m2 >= MIN_LOSS_M2 || (typeof w.loss_pct === 'number' && w.loss_pct >= MIN_LOSS_PCT))
    );

    const sortByArea = arr => arr.sort((a, b) => {
      if ((b.loss_m2 || 0) !== (a.loss_m2 || 0)) return (b.loss_m2 || 0) - (a.loss_m2 || 0);
      // tiebreaker: percent loss
      const ap = typeof a.loss_pct === 'number' ? a.loss_pct : -Infinity;
      const bp = typeof b.loss_pct === 'number' ? b.loss_pct : -Infinity;
      return bp - ap;
    });

    sortByArea(candidates);

    let top = candidates[0] || null;
    let note = null;

    // ---------- Fallback: loosen thresholds (still require prev_m2 > MIN_PREV_M2 and loss_m2>0) ----------
    if (!top) {
      const loose = wardResults.filter(w =>
        typeof w.loss_m2 === 'number' && isFinite(w.loss_m2) && w.loss_m2 > 0 &&
        typeof w.prev_m2 === 'number' && isFinite(w.prev_m2) && w.prev_m2 >= MIN_PREV_M2
      );
      sortByArea(loose);
      if (loose.length > 0) {
        top = loose[0];
        note = `loss below thresholds (minLossM2=${MIN_LOSS_M2}m², minLossPct=${MIN_LOSS_PCT}%)`;
      }
    }

    // If still nothing, return "no deforestation"
    if (!top) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.json({
        ward: null,
        loss_pct: 0.00,
        loss_m2: 0,
        latest_year: latestYear,
        previous_year: prevYear,
        message: 'No significant deforestation detected (no ward had prior tree area and positive loss).'
      });
    }

    // Diagnostics: log top 5 by loss_m2 (candidates or fallback)
    const diagList = (candidates.length ? candidates : wardResults.filter(w => w.loss_m2 > 0))
      .slice(0, 5)
      .map(w => ({
        ward: w.ward,
        prev_m2: Math.round(w.prev_m2||0),
        latest_m2: Math.round(w.latest_m2||0),
        loss_m2: Math.round(w.loss_m2||0),
        prev_pct: w.prev_pct !== null ? Number(w.prev_pct.toFixed(3)) : null,
        latest_pct: w.latest_pct !== null ? Number(w.latest_pct.toFixed(3)) : null,
        loss_pct: w.loss_pct !== null ? Number(w.loss_pct.toFixed(3)) : null
      }));
    console.log("[most-deforested] top candidates (server):", diagList);

    // Return winner (rounded)
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json({
      ward: top.ward,
      loss_pct: top.loss_pct !== null ? Number(top.loss_pct.toFixed(3)) : 0,
      loss_m2: Math.round(top.loss_m2 || 0),
      latest_year: latestYear,
      previous_year: prevYear,
      latest_pct: top.latest_pct !== null ? Number(top.latest_pct.toFixed(3)) : null,
      previous_pct: top.prev_pct !== null ? Number(top.prev_pct.toFixed(3)) : null,
      note
    });

  } catch (err) {
    console.error('❌ /most-deforested error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Most deforested ward error', details: String(err) });
  }
});
// GET /wardsstatstree
// Returns per-ward tree stats (tree_m2, area_m2, tree_pct) for the latest Dynamic World year.
// Paste this route below your existing /ward-trend route.
app.get('/wardsstatstree', async (req, res) => {
  try {
    // 1) Load wards asset (same as in your other code)
    const wardsFc = ee.FeatureCollection('projects/greenmap-backend/assets/nairobi_wards_filtered');
    const nairobiGeom = wardsFc.geometry();

    // 2) DW collection intersecting Nairobi & count
    const dwColAll = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').filterBounds(nairobiGeom);
    const dwCount = await dwColAll.size().getInfo(); // number

    // 3) Determine latest DW year (safe fallback)
    let latestYear;
    if (dwCount > 0) {
      const maxTime = await dwColAll.aggregate_max('system:time_start').getInfo(); // epoch ms
      // aggregate_max returns a timestamp (ms) or null; guard it
      latestYear = maxTime ? new Date(maxTime).getUTCFullYear() : new Date().getFullYear();
    } else {
      // no DW images intersecting - use current year as fallback (will yield zeros)
      latestYear = new Date().getFullYear();
    }

    // 4) Build label collection for that year and compute modal label (mode)
    const labelCol = dwColAll.filter(ee.Filter.calendarRange(latestYear, latestYear, 'year')).select('label');
    const labelColSize = await labelCol.size().getInfo();

    // If there are images this year, take the mode; otherwise a constant 0 image
    const labelModeImg = (labelColSize > 0)
      ? labelCol.mode()
      : ee.Image.constant(0).rename('label_mode');

    // 5) Binary tree mask = modal label == 1 (trees), ensure zeros where masked
    const treeMaskBinary = labelModeImg.eq(1).rename('tree_mask').unmask(0);

    // 6) Pixel area on same grid and expected tree area (m2)
    const pixelArea = ee.Image.pixelArea();
    const treeAreaImage = treeMaskBinary.multiply(pixelArea).rename('tree_m2');
    const stacked = treeAreaImage.addBands(pixelArea.rename('area_m2')); // two bands: tree_m2, area_m2

    // 7) Attach ward_area_m2 property (geometry area) to each ward to keep a safe fallback
    const wardsWithGeomArea = wardsFc.map(function(f) {
      return f.set('ward_area_m2', f.geometry().area());
    });

    // 8) Reduce sums to wards (sum of tree_m2 and area_m2) - use scale=10 and tileScale for robustness
    const perWardFc = stacked.reduceRegions({
      collection: wardsWithGeomArea,
      reducer: ee.Reducer.sum(),
      scale: 10,
      tileScale: 4
    });

    // 9) Fetch results to the Node side
    const perWardInfo = await perWardFc.getInfo(); // returns FeatureCollection JSON

    // 10) Build tidy array of ward stats (handle different possible property names returned by EE)
    const wardsOut = (perWardInfo.features || []).map(function(feat) {
      const p = feat.properties || {};

      // Ward name (try common fields)
      const wardName = p.NAME_3 || p.NAME || p.ward || p.WARD || 'Unknown';

      // tree_m2: prefer explicit property, else 'sum' fallback (first band's sum)
      let tree_m2 = 0;
      if (typeof p.tree_m2 !== 'undefined') tree_m2 = Number(p.tree_m2);
      else if (typeof p.sum !== 'undefined' && typeof p.sum_1 !== 'undefined') tree_m2 = Number(p.sum);
      else if (typeof p.sum !== 'undefined' && typeof p.sum_1 === 'undefined') tree_m2 = Number(p.sum);
      else tree_m2 = 0;

      // area_m2: prefer explicit property, else 'sum_1' (second band's sum), else fallback to ward_area_m2
      let area_m2 = 0;
      if (typeof p.area_m2 !== 'undefined') area_m2 = Number(p.area_m2);
      else if (typeof p.sum_1 !== 'undefined') area_m2 = Number(p.sum_1);
      else if (typeof p.ward_area_m2 !== 'undefined') area_m2 = Number(p.ward_area_m2);
      else area_m2 = 0;

      // Compute percent safely
      const tree_pct = (area_m2 > 0) ? (tree_m2 / area_m2) * 100 : 0;

      return {
        ward: wardName,
        tree_m2,
        area_m2,
        tree_pct: Number(tree_pct.toFixed(6)) // high precision; adjust formatting as you want
      };
    });

    // 11) Sort by tree_pct descending and return JSON
    wardsOut.sort((a, b) => b.tree_pct - a.tree_pct);

    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.json({
      updated: new Date().toISOString(),
      latestYear: latestYear,
      count: wardsOut.length,
      wards: wardsOut
    });
  } catch (err) {
    console.error('❌ /wardsstatstree error:', err);
    res.status(500).json({ error: 'wardsstatstree failed', details: String(err && err.message ? err.message : err) });
  }
});


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

    // START FROM 2018
    const yearsList = ee.List.sequence(2018, currentYear);
    const treeCollection = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').select('label');

    const yearList = await yearsList.getInfo();
    const trend = [];

    for (const y of yearList) {
      const start = ee.Date.fromYMD(y, 1, 1);
      const end = start.advance(1, 'year');

      // Collections scoped to the ward geometry / year
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

      // Count availability client-side
      const [s2Size, lsSize] = await Promise.all([s2.size().getInfo(), landsat.size().getInfo()]);

      // === NDVI: prefer S2 -> Landsat -> MODIS (always present historically) ===
      let ndviImg, ndviScale;
      if (s2Size > 0) {
        const s2Med = s2.median().clip(geometry);
        ndviImg = s2Med.normalizedDifference(['B8', 'B4']).rename('NDVI');
        ndviScale = 10;
      } else if (lsSize > 0) {
        const lsMed = landsat.median().clip(geometry);
        ndviImg = lsMed.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI');
        ndviScale = 30;
      } else {
        ndviImg = ee.ImageCollection('MODIS/061/MOD13Q1')
          .filterDate(start, end)
          .select('NDVI')
          .mean()
          .multiply(0.0001)
          .rename('NDVI')
          .clip(geometry);
        ndviScale = 250;
      }

      // Mask obviously invalid extreme NDVI artifacts (if present)
      ndviImg = ndviImg.updateMask(ndviImg.gte(-1)).updateMask(ndviImg.lte(1));

      // === NDBI for built-up: use SWIR sources when available, else fallback to NDVI-proxy ===
      let ndbiImg;
      let builtScale;
      if (s2Size > 0) {
        const s2Med = s2.median().clip(geometry);
        ndbiImg = s2Med.select('B11').subtract(s2Med.select('B8'))
          .divide(s2Med.select('B11').add(s2Med.select('B8')))
          .rename('NDBI');
        builtScale = 10;
      } else if (lsSize > 0) {
        const lsMed = landsat.median().clip(geometry);
        ndbiImg = lsMed.select('SR_B7').subtract(lsMed.select('SR_B5'))
          .divide(lsMed.select('SR_B7').add(lsMed.select('SR_B5')))
          .rename('NDBI');
        builtScale = 30;
      } else {
        // no SWIR — create a dummy NDBI that won't trigger SWIR-based built detection
        ndbiImg = ee.Image.constant(-1).rename('NDBI');
        builtScale = 250;
      }

      // built mask: SWIR-based NDBI > 0 OR conservative NDVI-proxy (NDVI < 0.12), still require NDVI<0.3
      const builtMaskImg = (ndbiImg.gt(0).or(ndviImg.lt(0.12))).and(ndviImg.lt(0.3)).selfMask();

      // Tree mask (Dynamic World)
      const treeMask = treeCollection
        .filterDate(start, end)
        .mode()
        .eq(1)
        .selfMask();

      const treeArea = treeMask.multiply(pixelArea).rename('tree_m2');
      const builtArea = builtMaskImg.multiply(pixelArea).rename('built_m2');

      // Total ward area using pixelArea
      const totalArea = pixelArea.clip(geometry).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry,
        scale: 10,
        maxPixels: 1e13
      });

      // Evaluate reduceRegion results robustly using withRetry helper
      const [
        ndviMeanObj,
        builtStats,
        treeStats,
        totalStats
      ] = await Promise.all([
        (async () => {
          try {
            return await withRetry(ndviImg.reduceRegion({
              reducer: ee.Reducer.mean(),
              geometry,
              scale: ndviScale,
              maxPixels: 1e13
            }));
          } catch (e) { return null; }
        })(),
        (async () => {
          try {
            return await withRetry(builtArea.reduceRegion({
              reducer: ee.Reducer.sum(),
              geometry,
              scale: builtScale,
              maxPixels: 1e13
            }));
          } catch (e) { return null; }
        })(),
        (async () => {
          try {
            return await withRetry(treeArea.reduceRegion({
              reducer: ee.Reducer.sum(),
              geometry,
              scale: 10,
              maxPixels: 1e13
            }));
          } catch (e) { return null; }
        })(),
        (async () => {
          try {
            return await withRetry(totalArea);
          } catch (e) { return null; }
        })()
      ]);

      // Extract and sanitize numbers
      const ndviValue = (ndviMeanObj && typeof ndviMeanObj.NDVI !== 'undefined' && ndviMeanObj.NDVI !== null)
        ? Number(ndviMeanObj.NDVI)
        : null;

      // built & tree numbers
      const tree_m2 = (treeStats && treeStats.tree_m2) ? Number(treeStats.tree_m2) : 0;
      const built_m2 = (builtStats && builtStats.built_m2) ? Number(builtStats.built_m2) : 0;
      const total_m2 = (totalStats && (totalStats.area || totalStats.sum)) ? Number(totalStats.area || totalStats.sum) : 1;

      // compute percentages safely and clamp into 0..100
      let tree_pct = total_m2 > 0 ? (tree_m2 / total_m2) * 100 : 0;
      let built_pct = total_m2 > 0 ? (built_m2 / total_m2) * 100 : 0;
      if (!isFinite(tree_pct) || tree_pct < 0) tree_pct = 0;
      if (!isFinite(built_pct) || built_pct < 0) built_pct = 0;
      if (tree_pct > 100) tree_pct = 100;
      if (built_pct > 100) built_pct = 100;

      // push the year result. Keep NDVI as null if it couldn't be computed
      trend.push({
        year: y,
        ndvi: ndviValue === null ? null : Number(Number(ndviValue).toFixed(4)),
        tree_pct: Number(tree_pct.toFixed(4)),
        built_pct: Number(built_pct.toFixed(4))
      });
    } // for years

    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({
      ward: wardName,
      trend,
      updated: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ /ward-trend error:', err);
    res.status(500).json({ error: 'Ward trend error', details: String(err && err.message ? err.message : err) });
  }
});
// Add this route inside your `startServer()` function in index.js (place it near the other summary/stat endpoints)
// Assumes: `ee` (Earth Engine) is initialized and `app` (Express) is available.
// This is a self-contained /indicators route: includes withRetry and getNDVI helpers.
// Place this into your index.js (or wherever you mount routes). Adjust asset path
// for wards if you keep wards as a global variable elsewhere.

// NOTE: if you already have a `withRetry` or `getNDVI` helper in your codebase,
// remove duplicates and keep the preferred version.

// Make sure you have ee initialized and authenticated earlier in your server
// Also recommended: app.use(require('cors')()); at server start to allow cross-origin fetches.

app.get('/indicators', async (req, res) => {
  console.log('📡 /indicators called');
  // Optional single-route CORS header (you already have global cors middleware usually)
  res.setHeader('Access-Control-Allow-Origin', '*');

  // simple withRetry that supports EE client objects (evaluate/getInfo) and plain values
  async function withRetry(obj, attempts = 3, waitMs = 1500) {
    if (obj === null || obj === undefined) return null;
    for (let i = 0; i < attempts; i++) {
      try {
        // If it's a server-side EE object with evaluate()
        if (typeof obj.evaluate === 'function') {
          const result = await new Promise((resolve, reject) => {
            obj.evaluate((value, err) => {
              if (err) return reject(err);
              resolve(value);
            });
          });
          return result;
        }
        // If it's an object with getInfo(success, error)
        if (typeof obj.getInfo === 'function') {
          const result = await new Promise((resolve, reject) => {
            try {
              // getInfo often supports (success, error)
              obj.getInfo(resolve, reject);
            } catch (err) {
              // some libs call getInfo(callback) only
              try {
                obj.getInfo((val) => resolve(val));
              } catch (err2) {
                reject(err2 || err);
              }
            }
          });
          return result;
        }
        // If it's a plain promise-like
        if (typeof obj.then === 'function') {
          return await obj;
        }
        // Otherwise it's already a plain value
        return obj;
      } catch (err) {
        console.warn(`withRetry attempt ${i + 1} failed:`, err && err.message ? err.message : err);
        if (i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    return null;
  }

  // defensive safeNumber extractor for reduceRegion outputs
  const safeNumber = (obj, keys) => {
    if (!obj) return null;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== null && obj[k] !== undefined) {
        const n = Number(obj[k]);
        return Number.isFinite(n) ? n : null;
      }
    }
    return null;
  };

  try {
    // ensure wards geometry exists server-side
    if (typeof wards === 'undefined' || !wards || typeof wards.geometry !== 'function') {
      console.error('❌ /indicators: `wards` geometry not defined on server (ensure you set it up).');
      return res.status(500).json({ error: '`wards` geometry not defined on server' });
    }

    // --- time windows ---
    const now = ee.Date(Date.now());
    const recentStart = now.advance(-120, 'day');   // NDVI recent window (120 days)
    const pastRef = now.advance(-1, 'year');        // same window last year
    const pastStart = pastRef.advance(-120, 'day');
    const lstWindow = now.advance(-30, 'day');      // LST last 30 days

    const geometry = wards.geometry();
    const pixelArea = ee.Image.pixelArea();

    // --- Helper: NDVI using Sentinel if available, fallback to MODIS ---
    function getNDVI(start, end) {
      const s2col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(geometry)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
        .select(['B4', 'B8']);

      const s2Available = s2col.size().gt(0);

      const s2NDVI = s2col.median().normalizedDifference(['B8', 'B4']).rename('NDVI');

      const modisNDVI = ee.ImageCollection('MODIS/006/MOD13Q1')
        .filterBounds(geometry)
        .filterDate(start, end)
        .select('NDVI')
        .map(img => img.multiply(0.0001))
        .median()
        .rename('NDVI');

      // pick sentinel if available else modis; clip to geometry
      return ee.Image(ee.Algorithms.If(s2Available, s2NDVI, modisNDVI)).clip(geometry);
    }

    // --- NDVI now & past ---
    const ndviNowImg = getNDVI(recentStart, now);
    const ndviPastImg = getNDVI(pastStart, pastRef);

    const ndviNowRR = ndviNowImg.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry,
      scale: 30,
      maxPixels: 1e13,
      tileScale: 4
    });

    const ndviPastRR = ndviPastImg.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry,
      scale: 30,
      maxPixels: 1e13,
      tileScale: 4
    });

    // --- Tree canopy: ESA WorldCover 2020 (class 10 === Trees) ---
    const esaImg = ee.Image('ESA/WorldCover/v100/2020').select('Map');
    const treeMask = esaImg.eq(10); // boolean (0/1)
    const treeAreaImg = treeMask.multiply(pixelArea).rename('tree_m2');

    const treeAreaRR = treeAreaImg.reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry,
      scale: 10,
      maxPixels: 1e13,
      tileScale: 4
    });

    const totalAreaRR = pixelArea.rename('area').clip(geometry).reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry,
      scale: 10,
      maxPixels: 1e13,
      tileScale: 4
    });

    // --- Built-up: S2 NDBI + NDVI proxy over past year; fallback image ensures band names exist ---
    const s2col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(geometry)
      .filterDate(pastRef, now)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20));

    const s2Fallback = ee.Image.constant([0, 0, 0]).rename(['B11', 'B8', 'B4']); // [SWIR, NIR, RED]
    const s2Med = ee.Image(ee.Algorithms.If(s2col.size().gt(0), s2col.median(), s2Fallback));

    const swir = s2Med.select('B11');
    const nir = s2Med.select('B8');
    const red = s2Med.select('B4');

    const ndbi = swir.subtract(nir).divide(swir.add(nir).add(1e-9)).rename('NDBI');
    const ndviProxy = nir.subtract(red).divide(nir.add(red).add(1e-9)).rename('NDVI_PROXY');

    // built mask is 1 where likely built-up
    const builtMask = ndbi.gt(0).and(ndviProxy.lt(0.3));

    const builtAreaImg = builtMask.multiply(pixelArea).rename('built_m2');

    const builtAreaRR = builtAreaImg.reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry,
      scale: 10,
      maxPixels: 1e13,
      tileScale: 4
    });

    // --- LST & UHI (MODIS MOD11A1 daytime) ---
    const lstImg = ee.ImageCollection('MODIS/061/MOD11A1')
      .filterBounds(geometry)
      .filterDate(lstWindow, now)
      .select('LST_Day_1km')
      .mean()
      .multiply(0.02)
      .subtract(273.15)
      .rename('LST_C')
      .clip(geometry);

    // Reduce with tileScale to avoid memory issues on large regions
    const urbanMeanRR = lstImg.updateMask(builtMask).reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry,
      scale: 1000,
      maxPixels: 1e13,
      tileScale: 4
    });

    const ruralMeanRR = lstImg.updateMask(builtMask.not()).reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry,
      scale: 1000,
      maxPixels: 1e13,
      tileScale: 4
    });

    // Hot area (>30°C) - area in m2
    const hotAreaImg = lstImg.gt(30).multiply(pixelArea).rename('hot_m2');
    const hotAreaRR = hotAreaImg.reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry,
      scale: 1000,
      maxPixels: 1e13,
      tileScale: 4
    });

    // Hot pixel count (1km pixels > 30C); sum of ones
    const hotCountImg = lstImg.gt(30).rename('hot');
    const hotCountRR = hotCountImg.reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry,
      scale: 1000,
      maxPixels: 1e13,
      tileScale: 4
    });

    // --- Evaluate all server-side objects robustly in parallel ---
    const [
      ndviNowRes,
      ndviPastRes,
      treeRes,
      totalRes,
      builtRes,
      urbanRes,
      ruralRes,
      hotRes,
      hotCountRes
    ] = await Promise.all([
      withRetry(ndviNowRR),
      withRetry(ndviPastRR),
      withRetry(treeAreaRR),
      withRetry(totalAreaRR),
      withRetry(builtAreaRR),
      withRetry(urbanMeanRR),
      withRetry(ruralMeanRR),
      withRetry(hotAreaRR),
      withRetry(hotCountRR)
    ]);

    // --- Convert safely to numbers ---
    const ndviNowVal = safeNumber(ndviNowRes, ['NDVI', 'mean']);
    const ndviPastVal = safeNumber(ndviPastRes, ['NDVI', 'mean']);

    const tree_m2 = safeNumber(treeRes, ['tree_m2', 'sum']);
    const total_m2 = safeNumber(totalRes, ['area', 'sum']);
    const built_m2 = safeNumber(builtRes, ['built_m2', 'sum']);

    const urbanLst = safeNumber(urbanRes, ['LST_C', 'mean']);
    const ruralLst = safeNumber(ruralRes, ['LST_C', 'mean']);
    const uhi_intensity = (urbanLst !== null && ruralLst !== null) ? (urbanLst - ruralLst) : null;

    const hot_m2 = safeNumber(hotRes, ['hot_m2', 'sum']);
    const hot_count = safeNumber(hotCountRes, ['hot', 'sum']);
    const hot_km2 = (hot_m2 !== null) ? (hot_m2 / 1e6) : null;

    // --- Derived percentages / trends ---
    const tree_pct = (tree_m2 !== null && total_m2 !== null && total_m2 > 0) ? (tree_m2 / total_m2) * 100 : null;
    const built_pct = (built_m2 !== null && total_m2 !== null && total_m2 > 0) ? (built_m2 / total_m2) * 100 : null;

    let ndvi_trend_pct = null;
    if (ndviNowVal !== null && ndviPastVal !== null && ndviPastVal !== 0) {
      ndvi_trend_pct = ((ndviNowVal - ndviPastVal) / Math.abs(ndviPastVal)) * 100;
    }

    // Helpful server-side diagnostics when values are missing
    if (urbanLst === null || ruralLst === null) {
      console.warn('⚠️ UHI components missing:', {
        urbanLst,
        ruralLst,
        built_m2: built_m2 !== null ? Math.round(built_m2) : built_m2,
        tree_m2: tree_m2 !== null ? Math.round(tree_m2) : tree_m2
      });
    }
    if (hot_count === 0 || hot_count === null) {
      console.info('ℹ️ Hot pixel count low/zero:', { hot_count, hot_m2, hot_km2 });
    }

    // --- Build response payload (include uhi_c alias) ---
    res.setHeader('Cache-Control', 'public, max-age=900'); // 15 minutes

    const payload = {
      updated: new Date().toISOString(),

      // Primary indicators
      tree_canopy_pct: tree_pct === null ? null : Number(tree_pct.toFixed(3)),
      builtup_pct: built_pct === null ? null : Number(built_pct.toFixed(3)),
      ndvi_avg: ndviNowVal === null ? null : Number(ndviNowVal.toFixed(4)),
      ndvi_trend_pct: ndvi_trend_pct === null ? null : Number(ndvi_trend_pct.toFixed(3)),

      // UHI / LST (frontend accepts uhi_intensity, lst_urban_avg/lst_rural_avg)
      uhi: uhi_intensity === null ? null : Number(uhi_intensity.toFixed(3)),
      uhi_intensity: uhi_intensity === null ? null : Number(uhi_intensity.toFixed(3)),
      uhi_c: uhi_intensity === null ? null : Number(uhi_intensity.toFixed(3)), // alias many frontends expect
      lst_urban_avg: urbanLst === null ? null : Number(urbanLst.toFixed(3)),
      lst_rural_avg: ruralLst === null ? null : Number(ruralLst.toFixed(3)),

      // hotspots / area
      uhi_hotspots_count: hot_count === null ? null : Math.round(hot_count),
      hot_area_m2: hot_m2 === null ? null : Math.round(hot_m2),
      hot_area_km2: hot_km2 === null ? null : (hot_km2 === null ? null : Number(hot_km2.toFixed(3))),

      // raw for diagnostics
      _raw: {
        tree_m2: tree_m2 === null ? null : Math.round(tree_m2),
        built_m2: built_m2 === null ? null : Math.round(built_m2),
        total_m2: total_m2 === null ? null : Math.round(total_m2),
        urban_lst_mean_c: urbanLst === null ? null : Number(urbanLst.toFixed(3)),
        rural_lst_mean_c: ruralLst === null ? null : Number(ruralLst.toFixed(3))
      }
    };

    // Log payload preview for debugging (safe to keep in logs, remove in production if verbose)
    console.log('📤 /indicators payload preview:', JSON.stringify({
      tree_canopy_pct: payload.tree_canopy_pct,
      builtup_pct: payload.builtup_pct,
      ndvi_avg: payload.ndvi_avg,
      uhi_c: payload.uhi_c,
      uhi_hotspots_count: payload.uhi_hotspots_count
    }, null, 2));

    return res.json(payload);
  } catch (err) {
    console.error('❌ /indicators error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Failed to compute indicators', details: String(err && err.message ? err.message : err) });
  }
});


app.get('/', (req, res) => {
  res.send('✅ GreenMap Earth Engine backend is live');
});
// ---------- PRECOMPUTE HELPERS & CACHED ROUTES (paste before app.listen) ----------
async function precomputeAll() {
  const base = `http://127.0.0.1:${PORT}`;
  console.log('🕛 precomputeAll starting for endpoints:', PRECOMP_ENDPOINTS);

  for (const ep of PRECOMP_ENDPOINTS) {
    const url = base + ep;
    try {
      console.log('🔁 Precomputing', url);
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`⚠️ ${url} returned status ${resp.status}`);
        continue;
      }
      const json = await resp.json();
      precomputed[ep] = json;
      console.log(`✅ Cached ${ep}`);
    } catch (err) {
      console.error(`❌ Error precomputing ${url}:`, err && err.message ? err.message : err);
    }
    // small pause between heavy EE hits
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('✅ precomputeAll complete');
}

// Create cached endpoints automatically, e.g. /indicators-cached -> uses precomputed['/indicators']
for (const ep of PRECOMP_ENDPOINTS) {
  const basePath = ep.split('?')[0];               // strip query string for route name
  const cachedRoute = basePath + '-cached';        // e.g. /indicators-cached

  app.get(cachedRoute, async (req, res) => {
    // 1) if we have cached JSON, return it immediately
    if (precomputed[ep]) {
      res.setHeader('Cache-Control', 'public, max-age=60'); // short client cache
      return res.json(precomputed[ep]);
    }
    // 2) fallback: try a live fetch to the local route (and populate cache)
    try {
      const live = await fetch(`http://127.0.0.1:${PORT}${ep}`);
      if (!live.ok) {
        return res.status(502).json({ error: 'Live fetch failed', status: live.status });
      }
      const data = await live.json();
      precomputed[ep] = data;
      return res.json(data);
    } catch (e) {
      return res.status(503).json({ error: 'Cache not ready & live fetch failed', details: String(e) });
    }
  });
}

// Schedule: run every day at 00:00 server-local time
cron.schedule('0 0 * * *', () => {
  console.log('🕛 Scheduled precompute job (Africa/Nairobi)');
  precomputeAll().catch(e => console.error('Precompute job error', e));
}, { timezone: 'Africa/Nairobi' });

// Note: we will call `precomputeAll()` once when the server starts listening
// (to avoid fetch-before-listen race).
// ---------------------------------------------------------------------------
// Optional: manual trigger (protect with a secret)
app.post('/admin/precompute-run', async (req, res) => {
  if (process.env.PRECOMP_SECRET && req.headers['x-precomp-secret'] !== process.env.PRECOMP_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await precomputeAll();
    res.json({ ok: true, ran: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  // run once on startup
  precomputeAll().catch(e => console.error('Precompute on startup failed:', e));
});
}