/**
 * Translation Model Service
 * English <-> Arabic translation microservice with:
 * - LRU-style in-memory cache
 * - Batched + bounded-parallel model inference
 * - Startup cache warmup for common storefront text
 * - Lightweight latency/cache metrics
 */

import express from "express"
import cors from "cors"
import { pipeline, env } from "@xenova/transformers"

env.cacheDir = "./models"
env.allowLocalModels = true

const app = express()
const PORT = Number(process.env.TRANSLATION_PORT || 5001)

// Model
let translator = null
let isLoading = false

const LANG_CODES = {
  en: "eng_Latn",
  ar: "arb_Arab",
}

// Cache + performance config
const CACHE_MAX_SIZE = Number(process.env.CACHE_MAX_SIZE || 50000)
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 24 * 60 * 60 * 1000)
const MODEL_BATCH_SIZE = Number(process.env.MODEL_BATCH_SIZE || 24)
const MODEL_PARALLEL_BATCHES = Number(process.env.MODEL_PARALLEL_BATCHES || 2)
const METRICS_WINDOW_SIZE = Number(process.env.METRICS_WINDOW_SIZE || 500)

// Startup prewarm config
const STARTUP_PREWARM_ENABLED = String(process.env.STARTUP_PREWARM_ENABLED || "true").toLowerCase() !== "false"
const STARTUP_PREWARM_DELAY_MS = Number(process.env.STARTUP_PREWARM_DELAY_MS || 2500)
const STARTUP_PREWARM_MAX_TEXTS = Number(process.env.STARTUP_PREWARM_MAX_TEXTS || 1200)
const PREWARM_SOURCE_API_URL = (process.env.PREWARM_SOURCE_API_URL || "https://api.grabatoz.ae").replace(/\/+$/, "")
const DYNAMIC_HOT_PHRASES = [
  "Intel Core i3",
  "Intel Core i5",
  "Intel Core i7",
  "Intel Core Ultra 7",
  "AMD Ryzen 5",
  "AMD Ryzen 7",
  "16GB RAM",
  "32GB RAM",
  "512GB SSD",
  "1TB SSD",
  "NVIDIA GeForce RTX",
  "Windows 11",
  "In Stock",
  "Out of Stock",
  "Pre-order",
  "Brand",
  "Category",
  "Warranty",
  "Product Description",
  "Specifications",
]

// LRU-style map: oldest at beginning, newest at end.
// key -> { translation, timestamp, lastAccess }
const translationCache = new Map()

const metrics = {
  cacheHits: 0,
  cacheMisses: 0,
  cacheWrites: 0,
  cacheEvictions: 0,
  cacheClears: 0,
  totalRequests: 0,
  batchRequests: 0,
  singleRequests: 0,
  errors: 0,
  warmupRuns: 0,
  warmupTexts: 0,
  warmupErrors: 0,
}

const latencyHistoryMs = []

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://www.grabatoz.ae",
      "https://grabatoz.ae",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  }),
)
app.use(express.json({ limit: "1mb" }))

const now = () => Date.now()
const getCacheKey = (text, direction) => `${direction}:${text}`

const rememberLatency = (ms) => {
  latencyHistoryMs.push(ms)
  if (latencyHistoryMs.length > METRICS_WINDOW_SIZE) latencyHistoryMs.shift()
}

const percentile = (arr, p) => {
  if (!arr || arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return Number(sorted[idx].toFixed(2))
}

const sanitizeWarmText = (value) => {
  if (!value || typeof value !== "string") return null
  const text = value.trim().replace(/\s+/g, " ")
  if (!text) return null
  if (!/[A-Za-z]/.test(text)) return null
  if (/[\u0600-\u06FF]/.test(text)) return null
  if (text.length > 160) return null
  return text
}

const chunkArray = (arr, size) => {
  const chunks = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

const getLangPair = (direction = "en-ar") =>
  direction === "en-ar" ? [LANG_CODES.en, LANG_CODES.ar] : [LANG_CODES.ar, LANG_CODES.en]

const extractTranslationText = (result, fallback) => {
  if (!result) return fallback
  if (typeof result === "string") return result
  if (Array.isArray(result)) {
    if (result.length === 0) return fallback
    const first = result[0]
    if (typeof first === "string") return first
    if (first && typeof first.translation_text === "string") return first.translation_text
    return fallback
  }
  if (typeof result.translation_text === "string") return result.translation_text
  return fallback
}

const promoteCacheEntry = (key, entry) => {
  // Touch for LRU order (delete+set puts key at end).
  translationCache.delete(key)
  translationCache.set(key, {
    translation: entry.translation,
    timestamp: entry.timestamp,
    lastAccess: now(),
  })
}

const getFromCache = (key) => {
  const entry = translationCache.get(key)
  if (!entry) {
    metrics.cacheMisses += 1
    return null
  }

  if (now() - entry.timestamp >= CACHE_TTL) {
    translationCache.delete(key)
    metrics.cacheEvictions += 1
    metrics.cacheMisses += 1
    return null
  }

  metrics.cacheHits += 1
  promoteCacheEntry(key, entry)
  return entry.translation
}

const setCache = (key, translation) => {
  if (translationCache.has(key)) {
    translationCache.delete(key)
  }
  translationCache.set(key, {
    translation,
    timestamp: now(),
    lastAccess: now(),
  })
  metrics.cacheWrites += 1

  while (translationCache.size > CACHE_MAX_SIZE) {
    const firstKey = translationCache.keys().next().value
    if (!firstKey) break
    translationCache.delete(firstKey)
    metrics.cacheEvictions += 1
  }
}

const clearCache = () => {
  translationCache.clear()
  metrics.cacheClears += 1
}

const runModelTranslation = async (input, direction = "en-ar") => {
  if (!translator) return input
  const [srcLang, tgtLang] = getLangPair(direction)
  return translator(input, { src_lang: srcLang, tgt_lang: tgtLang })
}

const translateSingleText = async (text, direction = "en-ar") => {
  if (!text || typeof text !== "string" || text.trim() === "") return text

  const cacheKey = getCacheKey(text, direction)
  const cached = getFromCache(cacheKey)
  if (cached) return cached

  try {
    const result = await runModelTranslation(text, direction)
    const translated = extractTranslationText(result, text)
    setCache(cacheKey, translated)
    return translated
  } catch (error) {
    console.error("Single translation error:", error.message)
    return text
  }
}

const processBatchesWithConcurrency = async (batches, handler, concurrency) => {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, async () => {
    while (index < batches.length) {
      const current = index
      index += 1
      const batch = batches[current]
      await handler(batch)
    }
  })
  await Promise.all(workers)
}

const translateBatchTexts = async (texts, direction = "en-ar") => {
  if (!Array.isArray(texts) || texts.length === 0) return []

  const normalizedTexts = texts.map((text) => (typeof text === "string" ? text : String(text ?? "")))
  const uniqueTexts = Array.from(new Set(normalizedTexts))
  const resolvedMap = new Map()
  const uncachedTexts = []

  uniqueTexts.forEach((text) => {
    if (!text || text.trim() === "") {
      resolvedMap.set(text, text)
      return
    }
    const cacheKey = getCacheKey(text, direction)
    const cached = getFromCache(cacheKey)
    if (cached) resolvedMap.set(text, cached)
    else uncachedTexts.push(text)
  })

  if (uncachedTexts.length > 0) {
    if (!translator) {
      uncachedTexts.forEach((text) => resolvedMap.set(text, text))
    } else {
      const batches = chunkArray(uncachedTexts, MODEL_BATCH_SIZE)

      await processBatchesWithConcurrency(
        batches,
        async (batch) => {
          try {
            const result = await runModelTranslation(batch, direction)
            const outputArray = Array.isArray(result) ? result : [result]

            if (outputArray.length !== batch.length) {
              for (const sourceText of batch) {
                const translated = await translateSingleText(sourceText, direction)
                resolvedMap.set(sourceText, translated)
              }
              return
            }

            batch.forEach((sourceText, i) => {
              const translated = extractTranslationText(outputArray[i], sourceText)
              resolvedMap.set(sourceText, translated)
              setCache(getCacheKey(sourceText, direction), translated)
            })
          } catch (error) {
            console.error("Batch translation error:", error.message)
            batch.forEach((sourceText) => resolvedMap.set(sourceText, sourceText))
          }
        },
        MODEL_PARALLEL_BATCHES,
      )
    }
  }

  return normalizedTexts.map((text) => resolvedMap.get(text) || text)
}

const fetchJsonWithTimeout = async (url, timeoutMs = 5000) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

const buildStartupWarmTexts = async () => {
  const [productsRaw, categoriesRaw, brandsRaw] = await Promise.all([
    fetchJsonWithTimeout(`${PREWARM_SOURCE_API_URL}/api/products?limit=300`, 7000),
    fetchJsonWithTimeout(`${PREWARM_SOURCE_API_URL}/api/categories`, 5000),
    fetchJsonWithTimeout(`${PREWARM_SOURCE_API_URL}/api/brands`, 5000),
  ])

  const products = Array.isArray(productsRaw?.data) ? productsRaw.data : Array.isArray(productsRaw) ? productsRaw : []
  const categories = Array.isArray(categoriesRaw?.data)
    ? categoriesRaw.data
    : Array.isArray(categoriesRaw)
      ? categoriesRaw
      : []
  const brands = Array.isArray(brandsRaw?.data) ? brandsRaw.data : Array.isArray(brandsRaw) ? brandsRaw : []

  const candidates = new Set()
  const push = (value) => {
    const text = sanitizeWarmText(value)
    if (text) candidates.add(text)
  }

  categories.forEach((c) => push(c?.name))
  brands.forEach((b) => push(b?.name))
  DYNAMIC_HOT_PHRASES.forEach((phrase) => push(phrase))

  products.forEach((p) => {
    push(p?.name)
    push(p?.brand?.name || p?.brand)
    push(p?.category?.name || p?.category)
    push(p?.warranty)
    if (Array.isArray(p?.specifications)) {
      p.specifications.forEach((spec) => {
        push(spec?.key)
        push(spec?.value)
      })
    }
  })

  return Array.from(candidates).slice(0, STARTUP_PREWARM_MAX_TEXTS)
}

const runStartupPrewarm = async () => {
  if (!STARTUP_PREWARM_ENABLED || !translator) return
  metrics.warmupRuns += 1
  try {
    const texts = await buildStartupWarmTexts()
    if (!texts || texts.length === 0) return
    await translateBatchTexts(texts, "en-ar")
    metrics.warmupTexts += texts.length
    console.log(`[Warmup] Preloaded ${texts.length} EN->AR texts into cache`)
  } catch (error) {
    metrics.warmupErrors += 1
    console.error("[Warmup] Error:", error.message)
  }
}

const loadModels = async () => {
  if (isLoading) return
  isLoading = true

  console.log("\nDownloading translation model...")
  try {
    translator = await pipeline("translation", "Xenova/nllb-200-distilled-600M")
    console.log("NLLB-200 model loaded")
  } catch (error) {
    console.error("Primary model load failed:", error.message)
    try {
      translator = await pipeline("translation", "Xenova/opus-mt-en-ar")
      console.log("Fallback opus-mt-en-ar loaded")
    } catch (fallbackError) {
      console.error("Fallback model load failed:", fallbackError.message)
    }
  }

  isLoading = false

  if (translator && STARTUP_PREWARM_ENABLED) {
    setTimeout(() => {
      runStartupPrewarm().catch(() => {})
    }, STARTUP_PREWARM_DELAY_MS)
  }
}

const handleTranslateRequest = async (req, res, direction) => {
  const startedAt = now()
  metrics.totalRequests += 1
  try {
    const { text, texts } = req.body

    if (!translator) {
      metrics.errors += 1
      return res.status(503).json({
        success: false,
        error: "Model still loading, please wait...",
        loading: isLoading,
      })
    }

    if (text) {
      metrics.singleRequests += 1
      const translated = await translateSingleText(text, direction)
      const durationMs = now() - startedAt
      rememberLatency(durationMs)
      return res.json({ success: true, translation: translated, durationMs })
    }

    if (Array.isArray(texts)) {
      metrics.batchRequests += 1
      const translations = await translateBatchTexts(texts, direction)
      const durationMs = now() - startedAt
      rememberLatency(durationMs)
      return res.json({ success: true, translations, durationMs })
    }

    metrics.errors += 1
    return res.status(400).json({ success: false, error: "No text provided" })
  } catch (error) {
    metrics.errors += 1
    console.error("Translation error:", error.message)
    return res.status(500).json({ success: false, error: error.message })
  }
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "translation-model",
    model: "NLLB-200-distilled-600M",
    modelLoaded: !!translator,
    cacheSize: translationCache.size,
    uptime: process.uptime(),
  })
})

app.get("/api/status", (req, res) => {
  res.json({
    ready: !!translator,
    loading: isLoading,
    model: "NLLB-200-distilled-600M",
    status: translator ? "loaded" : "not loaded",
  })
})

app.post("/api/translate/en-ar", async (req, res) => handleTranslateRequest(req, res, "en-ar"))
app.post("/api/translate/ar-en", async (req, res) => handleTranslateRequest(req, res, "ar-en"))

app.post("/api/translate", async (req, res) => {
  try {
    const { from = "en", to = "ar" } = req.body || {}
    const direction = `${from}-${to}`
    if (!["en-ar", "ar-en"].includes(direction)) {
      return res.status(400).json({
        success: false,
        error: "Invalid language pair. Supported: en-ar, ar-en",
      })
    }
    return handleTranslateRequest(req, res, direction)
  } catch (error) {
    metrics.errors += 1
    return res.status(500).json({ success: false, error: error.message })
  }
})

app.get("/api/cache/stats", (req, res) => {
  const totalLookups = metrics.cacheHits + metrics.cacheMisses
  const hitRate = totalLookups > 0 ? metrics.cacheHits / totalLookups : 0
  res.json({
    cache: {
      size: translationCache.size,
      maxSize: CACHE_MAX_SIZE,
      ttlHours: CACHE_TTL / (1000 * 60 * 60),
      utilization: Number((translationCache.size / CACHE_MAX_SIZE).toFixed(4)),
      hits: metrics.cacheHits,
      misses: metrics.cacheMisses,
      writes: metrics.cacheWrites,
      evictions: metrics.cacheEvictions,
      clears: metrics.cacheClears,
      hitRate: Number(hitRate.toFixed(4)),
    },
    performance: {
      requestCount: metrics.totalRequests,
      batchRequests: metrics.batchRequests,
      singleRequests: metrics.singleRequests,
      errors: metrics.errors,
      p50Ms: percentile(latencyHistoryMs, 50),
      p95Ms: percentile(latencyHistoryMs, 95),
      sampleSize: latencyHistoryMs.length,
    },
    model: {
      batchSize: MODEL_BATCH_SIZE,
      parallelBatches: MODEL_PARALLEL_BATCHES,
      loaded: !!translator,
      loading: isLoading,
    },
    warmup: {
      enabled: STARTUP_PREWARM_ENABLED,
      runs: metrics.warmupRuns,
      texts: metrics.warmupTexts,
      errors: metrics.warmupErrors,
      sourceApi: PREWARM_SOURCE_API_URL,
    },
  })
})

app.post("/api/cache/clear", (req, res) => {
  clearCache()
  res.json({ success: true, message: "Cache cleared" })
})

app.post("/api/cache/prewarm", async (req, res) => {
  const startedAt = now()
  try {
    const { texts, direction = "en-ar", fetchDefault = false } = req.body || {}
    if (!["en-ar", "ar-en"].includes(direction)) {
      return res.status(400).json({ success: false, error: "Invalid direction" })
    }
    if (!translator) {
      return res.status(503).json({ success: false, error: "Model not loaded yet", loading: isLoading })
    }

    let targets = Array.isArray(texts) ? texts : []
    if (fetchDefault) {
      const warmTexts = await buildStartupWarmTexts()
      targets = Array.from(new Set([...targets, ...warmTexts]))
    }
    const sanitized = targets.map(sanitizeWarmText).filter(Boolean)
    if (sanitized.length === 0) {
      return res.json({ success: true, warmed: 0, durationMs: now() - startedAt })
    }

    await translateBatchTexts(sanitized, direction)
    return res.json({
      success: true,
      warmed: sanitized.length,
      direction,
      durationMs: now() - startedAt,
    })
  } catch (error) {
    metrics.errors += 1
    return res.status(500).json({ success: false, error: error.message })
  }
})

app.listen(PORT, async () => {
  console.log(`Translation model service running on port ${PORT}`)
  loadModels()
})

export default app
