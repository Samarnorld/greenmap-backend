const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const fs = require('fs');
// ----- fetch polyfill (make fetch available in older Node) -----
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    // node-fetch v2 syntax (CommonJS). If you use node 18+, global.fetch exists and this is skipped.
    fetchFn = require('node-fetch'); // npm i node-fetch@2  (if your runtime is older than Node 18)
    global.fetch = fetchFn;
    console.log('Using node-fetch polyfill');
  } catch (e) {
    console.warn('Fetch is not available. Run Node 18+ or install node-fetch.');
    // fetchFn will remain undefined — precompute/fetch will then error early; but this warns you.
  }
}

const app = express();
app.use(cors({
  origin: '*'
}));
const PORT = process.env.PORT || 3000;
process.env.TZ = 'Africa/Nairobi';

// ---------- PRECOMPUTE SCHEDULER + CACHE (paste here) ----------
const cron = require('node-cron');

// endpoints we want to precompute (keep leading slashes)
// PRECOMPUTE: point to the heavy "-live" endpoints that actually compute results
const PRECOMP_ENDPOINTS = [
  '/wards-live',
  '/indicators-live',
  '/greencoverage-live',
  '/treecanopy-stats-live',
  '/wardsstatstree-live',
  '/builtup-stats-live',
  '/builtup-stats-dw-live',
  '/most-deforested-live',
  '/treeloss-stats-live',
  `/charttrend-live?startYear=2020&endYear=${new Date().getFullYear()}`
];


const precomputed = {}; // in-memory cache for JSON results
// ---------- Simple in-memory + disk-backed cache helper ----------
async function getOrComputeCache(cacheKey, ttlSeconds, computeFn) {
  try {
    const now = Date.now();

    // Use cached value if valid (in-memory)
    if (precomputed[cacheKey] && precomputed[cacheKey].expiry > now) {
      // console.log('cache HIT', cacheKey);
      return precomputed[cacheKey].value;
    }

    // Try disk load if present (you already have save/load helpers)
    try {
      const fileName = safeKeyToFile(cacheKey);
      const p = path.join(CACHE_DIR, fileName);
      if (fs.existsSync(p)) {
        const raw = await fs.promises.readFile(p, 'utf8');
        const parsed = JSON.parse(raw);
        // expected shape { value, expiry }
        if (parsed && parsed.expiry && parsed.expiry > now) {
          precomputed[cacheKey] = parsed;
          return parsed.value;
        }
      }
    } catch (e) {
      // ignore disk errors and compute fresh
    }

    // compute fresh value
    const value = await computeFn();

    // store in memory + disk
    precomputed[cacheKey] = {
      value,
      expiry: now + ttlSeconds * 1000
    };
    // async disk save (don't await blocking)
    saveCacheToDisk(cacheKey, precomputed[cacheKey]).catch(e => console.warn('saveCacheToDisk failed', e));

    return value;
  } catch (err) {
    console.error('getOrComputeCache error', err);
    // fallback: compute directly (don't cache)
    return await computeFn();
  }
}

// ----------------------------------------------------------------
// ----- disk-persisted cache helpers (so precomputed survives restarts) -----
const path = require('path');
const CACHE_DIR = path.join(__dirname, 'cache');

function safeKeyToFile(key) {
  return Buffer.from(key).toString('base64url') + '.json';
}

async function ensureCacheDir() {
  try { await fs.promises.mkdir(CACHE_DIR, { recursive: true }); } catch (e) {}
}

async function saveCacheToDisk(key, data) {
  try {
    await ensureCacheDir();
    const tmp = path.join(CACHE_DIR, safeKeyToFile(key) + '.tmp');
    const dest = path.join(CACHE_DIR, safeKeyToFile(key));
    await fs.promises.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    console.warn('Failed to save cache to disk for', key, e.message || e);
  }
}

async function loadCacheFromDisk() {
  try {
    await ensureCacheDir();
    const files = await fs.promises.readdir(CACHE_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const buf = await fs.promises.readFile(path.join(CACHE_DIR, f), 'utf8');
        const key = Buffer.from(f.replace(/\.json$/, ''), 'base64url').toString();
        precomputed[key] = JSON.parse(buf);
        console.log('Loaded cached key:', key);
      } catch (e) {
        console.warn('Skipping invalid cache file', f, e.message || e);
      }
    }
  } catch (e) {
    // no cache dir yet
  }
}


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

// --- NDVI helpers (drop-in) ---

// Strict S2 cloud mask using Scene Classification (SCL)
function maskS2SCL(img) {
  const scl = img.select('SCL');
  const good = scl.neq(0)   // NO_DATA
    .and(scl.neq(1))        // SATURATED/DEFECTIVE
    .and(scl.neq(3))        // CLOUD_SHADOW
    .and(scl.neq(8))        // CLOUD_MEDIUM_PROB
    .and(scl.neq(9))        // CLOUD_HIGH_PROB
    .and(scl.neq(10))       // THIN_CIRRUS
    .and(scl.neq(11));      // SNOW/ICE
  return img.updateMask(good);
}

function getNDVI(start, end, geometry) {
  geometry = geometry || wards.geometry();

  // --- Sentinel-2 SR (preferred) ---
  const s2col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(geometry)
    .filterDate(start, end)
    .map(maskS2SCL)
    .select(['B8', 'B4']) // NIR, RED
    .map(img => img.normalizedDifference(['B8', 'B4']).rename('NDVI'));
  const s2Size = s2col.size();

  // --- Landsat 8/9 L2 ---
  const ls89Col = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
    .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
    .filterBounds(geometry)
    .filterDate(start, end)
    .map(img => img.multiply(0.0000275).add(-0.2).copyProperties(img, img.propertyNames()))
    .select(['SR_B5', 'SR_B4']) // NIR, RED
    .map(img => img.normalizedDifference(['SR_B5', 'SR_B4']).rename('NDVI'));
  const ls89Size = ls89Col.size();

  // --- Landsat 7 L2 (NOTE: B4=NIR, B3=RED) ---
  const ls7Col = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
    .filterBounds(geometry)
    .filterDate(start, end)
    .map(img => img.multiply(0.0000275).add(-0.2).copyProperties(img, img.propertyNames()))
    .select(['SR_B4', 'SR_B3']) // NIR, RED (corrected)
    .map(img => img.normalizedDifference(['SR_B4', 'SR_B3']).rename('NDVI'));
  const ls7Size = ls7Col.size();

  // --- MODIS fallback ---
  const modisNDVI = ee.ImageCollection('MODIS/061/MOD13Q1')
    .filterBounds(geometry)
    .filterDate(start, end)
    .select('NDVI')
    .mean()
    .multiply(0.0001)
    .rename('NDVI');

  // Pick best available, use p50 (percentile) to be robust vs outliers.
  let ndvi = ee.Image(ee.Algorithms.If(
    s2Size.gt(0),
    s2col.reduce(ee.Reducer.percentile([50])).select('NDVI_p50').rename('NDVI'),
    ee.Algorithms.If(
      ls89Size.gt(0),
      ls89Col.reduce(ee.Reducer.percentile([50])).select('NDVI_p50').rename('NDVI'),
      ee.Algorithms.If(
        ls7Size.gt(0),
        ls7Col.reduce(ee.Reducer.percentile([50])).select('NDVI_p50').rename('NDVI'),
        modisNDVI
      )
    )
  ));

  // sanity clamp & clip
  ndvi = ndvi.updateMask(ndvi.gte(-1)).updateMask(ndvi.lte(1)).clip(geometry);
  return ndvi;
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

  const geometry = req.query.ward ? getWardGeometryByName(req.query.ward) : wards.geometry();
  const ndvi = getNDVI(startDate, endDate, geometry);

  serveTile(ndvi, {
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

  const geometry = req.query.ward ? getWardGeometryByName(req.query.ward) : wards.geometry();
  const threshold = Number(req.query.threshold) || 0.4;

  const ndvi = getNDVI(startDate, endDate, geometry);
  const mask = ndvi.updateMask(ndvi.gt(threshold));

  serveTile(mask, {
    min: threshold,
    max: 0.8,
    palette: ['yellow', 'green']
  }, res);
});


app.get('/ndvi-anomaly', (req, res) => {
  const currentDate = req.query.current ? ee.Date(req.query.current) : ee.Date(Date.now());
  const pastDate    = req.query.past    ? ee.Date(req.query.past)    : ee.Date(Date.now()).advance(-1, 'year');

  // use the same 120-day windows that your previous code used
  const currentStart = currentDate.advance(-120, 'day');
  const pastStart    = pastDate.advance(-120, 'day');

  const geometry = req.query.ward ? getWardGeometryByName(req.query.ward) : wards.geometry();

  const currentNDVI = getNDVI(currentStart, currentDate, geometry);
  const pastNDVI    = getNDVI(pastStart, pastDate, geometry);

  const anomaly = currentNDVI.subtract(pastNDVI).rename('NDVI_Anomaly');

  serveTile(anomaly, {
    min: -0.4,
    max:  0.4,
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
app.get('/builtup-stats-live', (req, res) => {

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
app.get(['/builtup-stats-dw-live', '/api/builtup-stats-dw-live'], async (req, res) => {

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

app.get('/wards-live', async (req, res) => {


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
// --- forest health radar (single JSON per ward) ---
app.get('/forest-health-radar', async (req, res) => {
  try {
    const wardName = req.query.ward;
    if (!wardName) return res.status(400).json({ error: 'Missing ?ward=' });
    const geom = getWardGeometryByName(wardName);
    if (!geom) return res.status(400).json({ error: 'Ward geometry not found' });

    // pixel area
    const pixelArea = ee.Image.pixelArea();

    // Tree cover % (Dynamic World mean for last 12 months)
    const now = ee.Date(Date.now());
    const start = now.advance(-1, 'year');
    const dwTrees = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').filterDate(start, now).select('trees');
    const treesMean = ee.Image(ee.Algorithms.If(dwTrees.size().gt(0), dwTrees.mean(), ee.Image.constant(0))).clip(geom);
    const treeFrac = await treesMean.reduceRegion({ reducer: ee.Reducer.mean(), geometry: geom, scale: 10, maxPixels: 1e13 }).getInfo();
    const tree_pct = (treeFrac && treeFrac.trees) ? Number((treeFrac.trees * 100).toFixed(3)) : 0;

    // Tree loss (last year, percent of baseline)
    const hansen = ee.Image("UMD/hansen/global_forest_change_2024_v1_12");
    const lossyear = hansen.select('lossyear');
    const baseline = hansen.select('treecover2000').gt(0).multiply(pixelArea);
    const baseline_m2 = (await baseline.reduceRegion({ reducer: ee.Reducer.sum(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).treecover2000 || 0;
    const latestYearVal = (await lossyear.reduceRegion({ reducer: ee.Reducer.max(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).lossyear || 0;
    // compute loss in last N years (example: last 1 year)
    const currentYear = new Date().getFullYear();
    const bandVal = currentYear - 2000; // approximate latest full-year band
    const lossMask = lossyear.eq(bandVal).selfMask();
    const lossM2 = (await lossMask.multiply(pixelArea).reduceRegion({ reducer: ee.Reducer.sum(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).sum || 0;
    const loss_pct = baseline_m2 > 0 ? (lossM2 / baseline_m2) * 100 : 0;

    // Soil health proxy: NDVI anomaly (current vs 1yr ago mean)
    const ndviNow = getNDVI(now.advance(-120, 'day'), now, geom);
    const ndviPast = getNDVI(now.advance(-1, 'year').advance(-120, 'day'), now.advance(-1, 'year'), geom);
    const ndviNowMean = (await ndviNow.reduceRegion({ reducer: ee.Reducer.mean(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).NDVI || 0;
    const ndviPastMean = (await ndviPast.reduceRegion({ reducer: ee.Reducer.mean(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).NDVI || 0;
    const ndvi_anom = ndviNowMean - ndviPastMean;

    // Urban pressure: built-up percent (Dynamic World built mean *100)
    const dwBuilt = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').filterDate(start, now).select('built');
    const builtMean = ee.Image(ee.Algorithms.If(dwBuilt.size().gt(0), dwBuilt.mean(), ee.Image.constant(0))).clip(geom);
    const built_pct = (await builtMean.reduceRegion({ reducer: ee.Reducer.mean(), geometry: geom, scale: 10, maxPixels: 1e13 }).getInfo()).built || 0;

    // Normalize & score (simple linear scalers — tweak to your preference)
    // Scores 0..100 where higher = better for tree cover & soil, lower built_pct is better (so invert)
    const score_tree = Math.min(100, Math.max(0, (tree_pct))); // already 0..100
    const score_loss = Math.max(0, 100 - (loss_pct * 10)); // penalize loss: larger loss -> lower score
    const score_soil = Math.min(100, Math.max(0, 50 + ndvi_anom * 100)); // simple mapping: >0 = improving
    const score_urban = Math.max(0, 100 - (built_pct * 100)); // built_pct is 0..1 -> invert

    const payload = {
      ward: wardName,
      scores: {
        tree_cover_pct: tree_pct,
        tree_loss_pct_year: Number(loss_pct.toFixed(4)),
        ndvi_anomaly: Number(ndvi_anom.toFixed(4)),
        built_mean: Number(built_pct),
        radar: {
          tree: Number(score_tree.toFixed(2)),
          loss: Number(score_loss.toFixed(2)),
          soil: Number(score_soil.toFixed(2)),
          urban: Number(score_urban.toFixed(2))
        }
      }
    };
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.json(payload);
  } catch (err) {
    console.error('/forest-health-radar error', err);
    res.status(500).json({ error: 'forest radar failed', details: String(err && err.message ? err.message : err) });
  }
});
// --- fragmentation index per ward (core vs edge fractions) ---
app.get('/fragmentation-live', async (req, res) => {
  try {
    const wardName = req.query.ward;
    const geom = wardName ? getWardGeometryByName(wardName) : wards.geometry();

    const ndviImg = getNDVI(ee.Date(Date.now()).advance(-120, 'day'), ee.Date(Date.now()), geom);
    const treeMask = ndviImg.gt(0.35);

    // compute distance from non-tree (edge detection)
    const nonTree = treeMask.not().selfMask();
    const dist = nonTree.fastDistanceTransform(30).sqrt().rename('dist'); // approximate
    const core = treeMask.updateMask(dist.gt(100)); // pixels >100m from edge = core
    const edge = treeMask.updateMask(dist.lte(100)).and(treeMask);

    const pixelArea = ee.Image.pixelArea();
    const coreArea = (await core.multiply(pixelArea).reduceRegion({ reducer: ee.Reducer.sum(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).sum || 0;
    const edgeArea = (await edge.multiply(pixelArea).reduceRegion({ reducer: ee.Reducer.sum(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).sum || 0;
    const total = coreArea + edgeArea;
    const result = {
      ward: wardName || 'city',
      core_m2: coreArea,
      edge_m2: edgeArea,
      core_pct: total > 0 ? (coreArea / total) * 100 : 0,
      edge_pct: total > 0 ? (edgeArea / total) * 100 : 0
    };
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(result);
  } catch (err) {
    console.error('/fragmentation-live error', err);
    res.status(500).json({ error: 'fragmentation failed', details: String(err && err.message ? err.message : err) });
  }
});
// --- soil health heuristic (NDVI trend + bare soil) ---
app.get('/soil-health-live', async (req, res) => {
  try {
    const wardName = req.query.ward;
    const geom = wardName ? getWardGeometryByName(wardName) : wards.geometry();
    const now = ee.Date(Date.now()), start = now.advance(-120, 'day');
    const ndviNow = getNDVI(start, now, geom);
    const ndviPast = getNDVI(start.advance(-1, 'year'), now.advance(-1, 'year'), geom);

    const ndviNowMean = (await ndviNow.reduceRegion({ reducer: ee.Reducer.mean(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).NDVI || 0;
    const ndviPastMean = (await ndviPast.reduceRegion({ reducer: ee.Reducer.mean(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).NDVI || 0;
    // bare soil index using SWIR/NIR from S2 median
    const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterDate(start, now).filterBounds(geom).median();
    const bareIndex = s2.normalizedDifference(['B11','B8']).rename('BSI'); // simple proxy
    const bareMean = (await bareIndex.reduceRegion({ reducer: ee.Reducer.mean(), geometry: geom, scale: 30, maxPixels: 1e13 }).getInfo()).BSI || 0;

    const soilScore = Math.max(0, Math.min(100, 50 + (ndviNowMean - ndviPastMean) * 100 - bareMean * 20));
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.json({ ward: wardName || 'city', ndvi_now: ndviNowMean, ndvi_past: ndviPastMean, bare_mean: bareMean, soil_score: Number(soilScore.toFixed(2)) });
  } catch (err) {
    console.error('/soil-health-live error', err);
    res.status(500).json({ error: 'soil health failed', details: String(err && err.message ? err.message : err) });
  }
});

app.get('/greencoverage-live', (req, res) => {

  console.log("🌿 /greencoverage called");

  const now = ee.Date(Date.now());
  const start = now.advance(-60, 'day');

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

// --- forest patches GeoJSON (for clickable markers) ---
app.get('/forest-patches-live', async (req, res) => {
  try {
    const ward = req.query.ward ? getWardGeometryByName(req.query.ward) : wards.geometry();
    const threshold = Number(req.query.threshold) || 0.35; // NDVI threshold
    const start = req.query.date ? ee.Date(req.query.date) : ee.Date(Date.now());
    const startWindow = start.advance(-120, 'day');

    // Use Sentinel NDVI where available
    const ndviImg = getNDVI(startWindow, start, ward);
    const mask = ndviImg.gt(threshold);

    // Vectorize patches (connected components -> reduce to polygons)
    const patches = mask.selfMask()
      .reduceToVectors({
        geometry: ward,
        scale: 30,
        geometryType: 'polygon',
        eightConnected: false,
        labelProperty: 'patch_id',
        maxPixels: 1e13
      }).map(f => {
        // compute area + mean NDVI inside each patch
        const area = ee.Number(ee.Image.pixelArea().reduceRegion({
          reducer: ee.Reducer.sum(),
          geometry: f.geometry(),
          scale: 30,
          maxPixels: 1e13
        }).get('area') || 0);
        const meanNdvi = ee.Number(ndviImg.reduceRegion({
          reducer: ee.Reducer.mean(),
          geometry: f.geometry(),
          scale: 30,
          maxPixels: 1e13
        }).get('NDVI') || 0);
        return f.set({ area_m2: area, mean_ndvi: meanNdvi });
      });

    // Convert to GeoJSON (getInfo)
    const info = await withRetry(patches, 3, 2000);
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.json(info); // features GeoJSON
  } catch (err) {
    console.error('/forest-patches-live error', err);
    res.status(500).json({ error: 'forest patches failed', details: String(err.message || err) });
  }
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

app.get('/treecanopy-stats-live', async (req, res) => {

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

// ---------- Configuration (tweak as needed) ----------
const ALERT_CONFIG = {
  // percent of baseline lost in the latest year to trigger an alert (0.5 => 0.5%)
  latestYearPercentThreshold: 0.5,
  // absolute m2 lost in latest year to trigger alert
  latestYearAbsThreshold_m2: 1000,
  // percent increase from previous year to trigger alert
  percentIncreaseVsPrevYear: 50, // 50% increase
  // cache TTL for near-real-time recompute (seconds) - lower -> more frequent recomputes
  shortTtlSeconds: 300,   // 5 minutes for alerts / fast refresh
  regularTtlSeconds: 3600 // 1 hour for main combined
};

// ---------- Auto years endpoint (reads dataset to find max lossyear) ----------
app.get('/treeloss-years', async (req, res) => {
  try {
    const hansen = ee.Image("UMD/hansen/global_forest_change_2024_v1_12");
    const lossyear = hansen.select('lossyear');

    // compute max lossyear value inside city geometry
    const maxObj = await lossyear.reduceRegion({
      reducer: ee.Reducer.max(),
      geometry: wards.geometry(),
      scale: 30,
      maxPixels: 1e13
    }).getInfo();

    // lossyear values are (1 => 2001). If no loss at all, max may be 0 or null
    const maxLossYearVal = (maxObj && (maxObj.lossyear || maxObj.lossyear === 0)) ? maxObj.lossyear : 0;
    const start = 2001;
    const detectedEnd = maxLossYearVal > 0 ? 2000 + maxLossYearVal : new Date().getFullYear();
    const end = Math.min(detectedEnd, new Date().getFullYear()); // never future beyond current year
    const years = [];
    for (let y = start; y <= end; y++) years.push(y);

    res.json({ start, end, years, detected_max_lossyear_value: maxLossYearVal });
  } catch (err) {
    console.error('/treeloss-years (auto) error', err);
    // fallback: return conservative range if EE fails
    const fallbackStart = 2001, fallbackEnd = new Date().getFullYear();
    const years = [];
    for (let y = fallbackStart; y <= fallbackEnd; y++) years.push(y);
    res.status(200).json({ start: fallbackStart, end: fallbackEnd, years, error: String(err && err.message ? err.message : err) });
  }
});


// ---------- Combined endpoint with percent, gain, net change, and per-ward baseline ----------
app.get('/treeloss-combined', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const short = req.query.short === '1' || req.query.short === 'true';
    const ttl = short ? ALERT_CONFIG.shortTtlSeconds : ALERT_CONFIG.regularTtlSeconds;
    const cacheKey = `/treeloss-combined:v2:${short ? 'short' : 'regular'}`;

    if (!forceRefresh && precomputed[cacheKey] && precomputed[cacheKey].expiry > Date.now()) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(precomputed[cacheKey].value);
    }

    res.setHeader('X-Cache', 'MISS');

    const computeFn = async () => {
      const hansen = ee.Image("UMD/hansen/global_forest_change_2024_v1_12");
      const loss = hansen.select("lossyear");
      const cover2000 = hansen.select("treecover2000");
      const gain = hansen.select("gain"); // single-band gain flag
      const pixelArea = ee.Image.pixelArea();

      // --- City grouped yearly loss (m2) ---
      const cityLoss = pixelArea.addBands(loss).reduceRegion({
        reducer: ee.Reducer.sum().group({ groupField: 1, groupName: 'lossyear' }),
        geometry: wards.geometry(),
        scale: 30,
        
      });
      const cityGroups = await ee.List(cityLoss.get('groups')).getInfo();
      const cityTrend = (cityGroups || []).map(g => ({ year: g.lossyear + 2000, loss_m2: g.sum || 0 }));

      // --- City baseline area (treecover2000 > 0) in m2 ---
      const baseCity = await cover2000.gt(0).multiply(pixelArea).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: wards.geometry(),
        scale: 30,
    
      }).getInfo();
      const baselineAreaCity = (baseCity && (baseCity.treecover2000 || baseCity['treecover2000'])) ? baseCity.treecover2000 : 0;

      // --- Ward-level baseline area (treecover2000 > 0) per ward (m2) ---
      const wardsBaseline = cover2000.gt(0).multiply(pixelArea).reduceRegions({
        collection: wards,
        reducer: ee.Reducer.sum(),
        scale: 30
      });
      const wardsBaselineInfo = await wardsBaseline.getInfo();

      // --- Ward-level loss grouped by year (one call) ---
      const wardsLoss = pixelArea.addBands(loss).reduceRegions({
  collection: wards,
  reducer: ee.Reducer.sum().group({ groupField: 1, groupName: 'lossyear' }),
  scale: 30,
  tileScale: 2
});

      const wardData = await wardsLoss.getInfo();

      // build baseline map
      const baselineMap = {};
      (wardsBaselineInfo.features || []).forEach(f => {
        const name = f.properties.NAME_3 || f.properties.ward || f.properties.WARD || 'Unknown';
        baselineMap[name] = f.properties.sum || 0;
      });

      // --- Gain (TOTAL)
      const cityGainObj = await gain.multiply(pixelArea).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: wards.geometry(),
        scale: 30,
       
      }).getInfo();
      const cityGain_m2 = cityGainObj && cityGainObj.gain ? cityGainObj.gain : 0;

      const wardsGain = gain.multiply(pixelArea).reduceRegions({
        collection: wards,
        reducer: ee.Reducer.sum(),
        scale: 30,
        
      });
      const wardsGainInfo = await wardsGain.getInfo();
      const wardGainMap = {};
      (wardsGainInfo.features || []).forEach(f => {
        const name = f.properties.NAME_3 || f.properties.ward || f.properties.WARD || 'Unknown';
        wardGainMap[name] = f.properties.sum || 0;
      });

      // --- Compose ward trend results with percentages ---
      const wardTrendResults = (wardData.features || []).map(w => {
        const groups = w.properties.groups || [];
        const wardName = w.properties.NAME_3 || w.properties.ward || w.properties.WARD || 'Unknown';
        const trend = groups.map(g => {
          const year = g.lossyear + 2000;
          const loss_m2 = g.sum || 0;
          const baseline_m2 = baselineMap[wardName] || 0;
          const pct_of_baseline = baseline_m2 > 0 ? (loss_m2 / baseline_m2) * 100 : 0;
          return { year, loss_m2, pct_of_baseline };
        });

        const totalLoss = trend.reduce((acc, t) => acc + (t.loss_m2 || 0), 0);
        const baseline_m2 = baselineMap[wardName] || 0;
        const totalGain = wardGainMap[wardName] || 0;
        const total_pct_loss = baseline_m2 > 0 ? (totalLoss / baseline_m2) * 100 : 0;

        return {
          ward: wardName,
          baseline_m2,
          total_gain_m2: totalGain,
          total_loss_m2: totalLoss,
          total_pct_loss,
          trend
        };
      });

      // --- City-level percent per year and latest-year percent ---
      const cityTrendWithPct = cityTrend.map(t => {
        const pct = baselineAreaCity > 0 ? (t.loss_m2 / baselineAreaCity) * 100 : 0;
        return { year: t.year, loss_m2: t.loss_m2, pct_of_baseline: pct };
      });

      const sortedCityTrend = cityTrendWithPct.slice().sort((a,b) => a.year - b.year);
      const latest = sortedCityTrend[sortedCityTrend.length - 1] || null;
      const prev = sortedCityTrend.length > 1 ? sortedCityTrend[sortedCityTrend.length - 2] : null;

      const cityTotalLoss = cityTrend.reduce((a,b) => a + (b.loss_m2||0), 0);
      const cityNetOverall_m2 = (cityGain_m2 || 0) - cityTotalLoss;

      const ranked = wardTrendResults.slice().sort((a,b) => b.total_loss_m2 - a.total_loss_m2);

      return {
        updated: new Date().toISOString(),
        notes: [
          "Percent values are percent of the ward/city baseline (treecover2000 > 0) measured in 2000.",
          "Hansen 'gain' band is a single-period gain flag (not annual). 'total_gain_m2' is therefore total gain area, not per-year gain.",
          "Net yearly gain cannot be derived from Hansen per-year bands — net_overall is computed as total_gain - total_loss over the product period."
        ],
        city: {
          baseline_m2: baselineAreaCity,
          trend: cityTrendWithPct,
          latest: latest,
          previous: prev,
          total_loss_m2: cityTotalLoss,
          total_gain_m2: cityGain_m2,
          net_overall_m2: cityNetOverall_m2
        },
        wards: wardTrendResults,
        wards_ranked: ranked,
        forest_only_note: "Forest-only yearly loss (cover2000>=30) available in older endpoint if needed"
      };
    };

    // use the cache helper (this will persist to disk via saveCacheToDisk)
    const result = await getOrComputeCache(cacheKey, ttl, computeFn);
    res.json(result);

  } catch (err) {
    console.error("treeloss-combined (v2) error", err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// ---------- Tree Loss Tile Endpoint (supports per-year + per-ward) ----------
app.get('/treeloss-tile', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10);
    const wardName = req.query.ward ? String(req.query.ward).trim() : null;

    if (!year || year < 2001 || year > new Date().getFullYear()) {
      return res.status(400).json({ error: `Invalid year. Must be between 2001–${new Date().getFullYear()}` });
    }

    // Use 2024 product (or the latest Hansen you maintain)
    const hansen = ee.Image("UMD/hansen/global_forest_change_2024_v1_12");
    const lossyear = hansen.select('lossyear');

    // Hansen lossyear band uses: 1 = 2001, 2 = 2002, ...
    const bandVal = year - 2000;

    // ---------- Determine geometry ----------
    let geometry = wards.geometry(); // default: whole Nairobi

    if (wardName) {
      // try multiple property keys
      const wardFeature = wards.filter(
        ee.Filter.or(
          ee.Filter.equals("NAME_3", wardName),
          ee.Filter.equals("wards", wardName),
          ee.Filter.equals("WARD", wardName)
        )
      ).first();

      // evaluate existence (safe)
      const exists = await new Promise((resolve) => {
        wardFeature.getInfo((f, err) => resolve(!!(f && !err)));
      });

      if (exists) {
        geometry = wardFeature.geometry();
      } else {
        console.warn(`Ward not found: ${wardName} — serving full city instead`);
      }
    }

    // ---------- Mask pixels equal to selected year and clip ----------
    const mask = lossyear.eq(bandVal).selfMask().clip(geometry);

    // ---------- Serve via your tile helper ----------
    serveTile(mask, {
      min: 1,
      max: 1,
      palette: ['#ffeda0', '#feb24c', '#f03b20']  // light → orange → red
    }, res);

  } catch (err) {
    console.error('/treeloss-tile error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});


// ---------- Alerts endpoint (simple, configurable rules) ----------
app.get('/treeloss-alerts', async (req, res) => {
  try {
    // Try to use short-cached combined result for speed
    const combinedResp = await (async () => {
      const cacheKey = '/treeloss-combined:v2:short';
      if (precomputed[cacheKey]) return precomputed[cacheKey];
      // force compute with short TTL
      const resp = await new Promise((resolve, reject) => {
        // call internal endpoint logic by reusing compute flow (simulate refresh param)
        // simplified: call the compute function path - to keep example self-contained, call /treeloss-combined?short=1&refresh=1
        // but simplest for now: trigger the endpoint programmatically is environment-specific.
        // Instead, call /treeloss-combined with refresh (if your server can call itself)
       const selfUrl = process.env.SELF_URL || `http://localhost:${PORT}`;
require('node-fetch')(`${selfUrl.replace(/\/$/, '')}/treeloss-combined?short=1&refresh=1`)
          .then(r => r.json()).then(resolve).catch(reject);
      });
      return resp;
    })();

    const alerts = [];
    if (!combinedResp || !combinedResp.wards) {
      return res.json({ alerts: [], note: 'No ward data available' });
    }

    const latestYearCity = combinedResp.city && combinedResp.city.latest ? combinedResp.city.latest.year : null;
    combinedResp.wards.forEach(w => {
      const ward = w.ward;
      const baseline = w.baseline_m2 || 0;
      const trend = w.trend || [];
      // find latest year record for the ward
      const latest = trend.slice().sort((a,b) => a.year - b.year).pop() || null;
      if (!latest) return;

      const prev = trend.slice().sort((a,b) => a.year - b.year).slice(-2, -1)[0] || null;

      const pct = latest.pct_of_baseline || 0;
      const absLoss = latest.loss_m2 || 0;
      let triggered = false;
      const reasons = [];

      if (pct >= ALERT_CONFIG.latestYearPercentThreshold) {
        triggered = true;
        reasons.push(`>= ${ALERT_CONFIG.latestYearPercentThreshold}% of baseline lost in ${latest.year}`);
      }
      if (absLoss >= ALERT_CONFIG.latestYearAbsThreshold_m2) {
        triggered = true;
        reasons.push(`${absLoss.toFixed(0)} m2 lost in ${latest.year} >= threshold ${ALERT_CONFIG.latestYearAbsThreshold_m2} m2`);
      }
      if (prev) {
        const prevLoss = prev.loss_m2 || 0;
        if (prevLoss === 0 && absLoss > 0 && prevLoss !== absLoss) {
          // special case - went from 0 to >0 loss
          triggered = true;
          reasons.push(`Loss appeared in ${latest.year} (was zero previous)`);
        } else if (prevLoss > 0) {
          const pctInc = ((absLoss - prevLoss) / prevLoss) * 100;
          if (pctInc >= ALERT_CONFIG.percentIncreaseVsPrevYear) {
            triggered = true;
            reasons.push(`Loss increased ${pctInc.toFixed(0)}% vs previous year`);
          }
        }
      }

      if (triggered) {
        alerts.push({
          ward,
          baseline_m2: baseline,
          latest_year: latest.year,
          latest_loss_m2: absLoss,
          latest_pct_of_baseline: pct,
          reasons
        });
      }
    });

    res.json({ generated_at: new Date().toISOString(), count: alerts.length, alerts });
  } catch (err) {
    console.error('/treeloss-alerts error', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});


// GET /charttrend?startYear=2021&endYear=2025
// GET /charttrend?startYear=2021&endYear=2025
app.get('/charttrend-live', async (req, res) => {

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
app.get('/most-deforested-live', async (req, res) => {

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
// --- illegal logging candidates (Hansen change + NDVI drop) ---
app.get('/illegal-logging-live', async (req, res) => {
  try {
    const wardName = req.query.ward;
    const geom = wardName ? getWardGeometryByName(wardName) : wards.geometry();
    const hansen = ee.Image("UMD/hansen/global_forest_change_2024_v1_12");
    const loss = hansen.select('lossyear');
    // detect recent losses (last 2 years)
    const currentYear = new Date().getFullYear();
    const recentBand = currentYear - 2000;
    const recentLossMask = loss.gte(recentBand - 1).and(loss.lte(recentBand)).selfMask().clip(geom);
    // optionally filter by NDVI drop
    const now = ee.Date(Date.now());
    const currNdvi = getNDVI(now.advance(-120, 'day'), now, geom);
    const pastNdvi  = getNDVI(now.advance(-1, 'year').advance(-120, 'day'), now.advance(-1, 'year'), geom);
    const ndviDrop = pastNdvi.subtract(currNdvi).gt(0.15); // large drop
    const suspect = recentLossMask.updateMask(ndviDrop);

    // vectorize small clearings
    const patches = suspect.reduceToVectors({
      geometry: geom,
      scale: 30,
      geometryType: 'centroid',
      eightConnected: false,
      labelProperty: 'l'
    });

    const info = await withRetry(patches, 3, 2000);
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.json(info);
  } catch (err) {
    console.error('/illegal-logging-live error', err);
    res.status(500).json({ error: 'illegal logging failed', details: String(err && err.message ? err.message : err) });
  }
});

// GET /wardsstatstree
// Returns per-ward tree stats (tree_m2, area_m2, tree_pct) for the latest Dynamic World year.
// Paste this route below your existing /ward-trend route.
app.get('/wardsstatstree-live', async (req, res) => {

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


app.get('/ward-trend-live', async (req, res) => {
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

app.get('/indicators-live', async (req, res) => {
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
    const recentStart = now.advance(-30, 'day');   // NDVI recent window (30 days)
    const pastRef = now.advance(-1, 'year');        // same window last year
    const pastStart = pastRef.advance(-30, 'day');
    const lstWindow = now.advance(-30, 'day');      // LST last 30 days

    const geometry = wards.geometry();
    const pixelArea = ee.Image.pixelArea();

  
   // --- NDVI now & past ---
const ndviNowImg  = getNDVI(recentStart, now, geometry);
const ndviPastImg = getNDVI(pastStart,  pastRef, geometry);

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

// ----------------- Wrapper for /ward-trend (cache-aware, on-demand) -----------------
app.get('/ward-trend', async (req, res) => {
  try {
    const wardName = req.query.ward;
    if (!wardName) {
      return res.status(400).json({ error: 'Missing ?ward= name' });
    }

    // Use query param as part of cache key (canonical encoding)
    const cacheKey = `/ward-trend?ward=${encodeURIComponent(wardName)}`;

    // 1) Serve from cache if available
    if (precomputed[cacheKey]) {
      console.log(`✅ cache hit for ${cacheKey}`);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.json(precomputed[cacheKey]);
    }

    // 2) Otherwise fetch the live handler and cache
    const liveUrl = `http://127.0.0.1:${PORT}/ward-trend-live?ward=${encodeURIComponent(wardName)}`;
    console.log(`⚡ cache miss for ${cacheKey}, fetching live: ${liveUrl}`);

    if (!fetchFn) throw new Error('fetch not available (install node-fetch or use Node 18+)');

    const resp = await fetchFn(liveUrl);
    if (!resp.ok) {
      const t = await resp.text().catch(()=>'');
      throw new Error(`Live fetch failed ${resp.status}: ${t}`);
    }
    const data = await resp.json();

    // Save to in-memory cache + disk
    precomputed[cacheKey] = data;
    try { await saveCacheToDisk?.(cacheKey, data); } catch (e) {/* ignore */}

    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.json(data);
  } catch (err) {
    console.error('❌ /ward-trend wrapper error:', err && (err.message || err));
    return res.status(502).json({ error: 'Ward trend wrapper error', details: String(err && err.message ? err.message : err) });
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
    const url = base + ep; // ep already contains -live (we changed PRECOMP_ENDPOINTS)
    try {
      console.log('🔁 Precomputing', url);
      if (!fetchFn) throw new Error('fetch not available (install node-fetch or run Node 18+)');
      const resp = await fetchFn(url, { timeout: 120000 });
      if (!resp.ok) {
        console.warn(`⚠️ ${url} returned status ${resp.status}`);
        continue;
      }
      const json = await resp.json();
      precomputed[ep] = json;
      try { await saveCacheToDisk?.(ep, json); } catch (e) { /* ignore disk errors */ }
      console.log(`✅ Cached ${ep}`);
    } catch (err) {
      console.error(`❌ Error precomputing ${url}:`, err && err.message ? err.message : err);
    }
    // pause between heavy EE hits
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('✅ precomputeAll complete');
}

// ----------------- Cache-first wrapper routes (original paths) -----------------
// For each PRECOMP_ENDPOINTS entry (which now points at -live), create a wrapper
// that serves precomputed if available, otherwise forwards to the -live route.
for (const ep of PRECOMP_ENDPOINTS) {
  const basePath = ep.split('?')[0].replace(/-live$/, ''); // e.g. '/indicators-live' -> '/indicators'
  app.get(basePath, async (req, res) => {
    try {
      // build querystring if exists
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

      // 1) Exact cache key (path + qs)
      const exactKey = basePath + qs;

      // 2) The precompute default key (the ep from PRECOMP_ENDPOINTS)
      const defaultKey = ep;

      // 3) Serve exact cache hit
      if (precomputed[exactKey]) {
        console.log(`✅ cache hit exact: ${exactKey}`);
        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.json(precomputed[exactKey]);
      }
      // 4) Serve default precompute hit
      if (precomputed[defaultKey]) {
        console.log(`✅ cache hit default: ${defaultKey}`);
        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.json(precomputed[defaultKey]);
      }

      // 5) Fallback: fetch live from the -live route and populate cache
      const liveUrl = `http://127.0.0.1:${PORT}${basePath}-live${qs}`;
      console.log(`⚡ cache miss for ${exactKey}. Fetching live: ${liveUrl}`);
      if (!fetchFn) throw new Error('fetch not available (install node-fetch or run Node 18+)');

      const liveRes = await fetchFn(liveUrl);
      if (!liveRes.ok) {
        const text = await liveRes.text().catch(() => '');
        throw new Error(`Live fetch failed with status ${liveRes.status}: ${text}`);
      }
      const data = await liveRes.json();

      // Save to in-memory cache (and disk if configured)
      precomputed[exactKey] = data;
      try { await saveCacheToDisk?.(exactKey, data); } catch (e) { /* ignore */ }

      return res.json(data);
    } catch (err) {
      console.error(`❌ wrapper error for ${basePath}:`, err && err.message ? err.message : err);
      return res.status(502).json({ error: 'Failed to fetch data (live)', details: String(err) });
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
  // --- start listening (inside startServer so EE was initialized and routes are registered) ---
  app.listen(PORT, async () => {
    console.log(`🚀 Backend running on http://localhost:${PORT}`);
    // load persisted cache (if any)
    try {
      await loadCacheFromDisk();
    } catch (e) {
      console.warn('Failed to load cache from disk at startup:', e && e.message ? e.message : e);
    }
    // warm-run the precompute (short delay to allow anything else to settle)
    setTimeout(() => {
      precomputeAll().catch(e => console.error('Precompute on startup failed:', e));
    }, 2000);
  });


}