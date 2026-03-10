/**
 * Translation Model Service
 * Uses Meta's NLLB-200 (No Language Left Behind) for high-quality translation
 * One of the best translation models - supports 200 languages!
 * Model runs LOCALLY - no API key needed!
 * 
 * Run on separate port for microservice architecture
 */

import express from 'express';
import cors from 'cors';
import { pipeline, env } from '@xenova/transformers';

// Configure transformers.js to download models to local cache
env.cacheDir = './models';
env.allowLocalModels = true;

const app = express();
const PORT = process.env.TRANSLATION_PORT || 5001;

// Model instance (NLLB handles all language pairs with one model!)
let translator = null;
let isLoading = false;

// Language codes for NLLB-200 model
const LANG_CODES = {
  en: 'eng_Latn',  // English
  ar: 'arb_Arab',  // Arabic (Modern Standard)
};

// In-memory cache for translations
const translationCache = new Map();
const CACHE_MAX_SIZE = 10000;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MODEL_BATCH_SIZE = 12;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'https://www.grabatoz.ae', 'https://grabatoz.ae'],
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());

// Cache helper functions
const getCacheKey = (text, direction) => `${direction}:${text}`;

const getFromCache = (key) => {
  const cached = translationCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.translation;
  }
  if (cached) {
    translationCache.delete(key);
  }
  return null;
};

const setCache = (key, translation) => {
  if (translationCache.size >= CACHE_MAX_SIZE) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  translationCache.set(key, { translation, timestamp: Date.now() });
};

const getLangPair = (direction = 'en-ar') => (
  direction === 'en-ar'
    ? [LANG_CODES.en, LANG_CODES.ar]
    : [LANG_CODES.ar, LANG_CODES.en]
);

const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

const extractTranslationText = (result, fallback) => {
  if (!result) return fallback;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    if (result.length === 0) return fallback;
    const first = result[0];
    if (typeof first === 'string') return first;
    if (first && typeof first.translation_text === 'string') return first.translation_text;
    return fallback;
  }
  if (typeof result.translation_text === 'string') return result.translation_text;
  return fallback;
};

const runModelTranslation = async (input, direction = 'en-ar') => {
  if (!translator) return input;
  const [srcLang, tgtLang] = getLangPair(direction);
  return translator(input, { src_lang: srcLang, tgt_lang: tgtLang });
};

const translateSingleText = async (text, direction = 'en-ar') => {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return text;
  }

  const cacheKey = getCacheKey(text, direction);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const result = await runModelTranslation(text, direction);
    const translated = extractTranslationText(result, text);
    setCache(cacheKey, translated);
    return translated;
  } catch (error) {
    console.error('Single translation error:', error.message);
    return text;
  }
};

const translateBatchTexts = async (texts, direction = 'en-ar') => {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const normalizedTexts = texts.map((text) => (typeof text === 'string' ? text : String(text ?? '')));
  const uniqueTexts = Array.from(new Set(normalizedTexts));
  const resolvedMap = new Map();
  const uncachedTexts = [];

  // Resolve from cache first
  uniqueTexts.forEach((text) => {
    if (!text || text.trim() === '') {
      resolvedMap.set(text, text);
      return;
    }
    const cacheKey = getCacheKey(text, direction);
    const cached = getFromCache(cacheKey);
    if (cached) {
      resolvedMap.set(text, cached);
    } else {
      uncachedTexts.push(text);
    }
  });

  if (uncachedTexts.length > 0) {
    if (!translator) {
      console.warn('Model not loaded yet, returning original texts');
      uncachedTexts.forEach((text) => resolvedMap.set(text, text));
    } else {
      const batches = chunkArray(uncachedTexts, MODEL_BATCH_SIZE);

      for (const batch of batches) {
        try {
          const result = await runModelTranslation(batch, direction);
          const outputArray = Array.isArray(result) ? result : [result];

          // If model batch output shape is unexpected, fallback to per-item translation.
          if (outputArray.length !== batch.length) {
            console.warn(
              `Batch output mismatch for ${direction}: expected ${batch.length}, got ${outputArray.length}. Falling back to per-item translation.`
            );
            for (const sourceText of batch) {
              const translated = await translateSingleText(sourceText, direction);
              resolvedMap.set(sourceText, translated);
            }
            continue;
          }

          batch.forEach((sourceText, index) => {
            const translated = extractTranslationText(outputArray[index], sourceText);
            resolvedMap.set(sourceText, translated);
            setCache(getCacheKey(sourceText, direction), translated);
          });
        } catch (error) {
          console.error('Batch translation error:', error.message);
          batch.forEach((sourceText) => resolvedMap.set(sourceText, sourceText));
        }
      }
    }
  }

  return normalizedTexts.map((text) => resolvedMap.get(text) || text);
};

// Load translation models
const loadModels = async () => {
  if (isLoading) return;
  isLoading = true;
  
  console.log('\n📥 Downloading Meta NLLB-200 translation model...');
  console.log('   This is one of the best translation models available!');
  console.log('   First run may take a few minutes to download (~600MB).\n');
  
  try {
    // Load NLLB-200 distilled model - excellent quality, reasonable size
    console.log('Loading NLLB-200-distilled-600M model...');
    translator = await pipeline('translation', 'Xenova/nllb-200-distilled-600M', {
      progress_callback: (progress) => {
        if (progress.status === 'downloading') {
          const pct = Math.round((progress.loaded / progress.total) * 100);
          process.stdout.write(`\r   Downloading: ${pct}%  `);
        }
      }
    });
    console.log('\n   ✅ NLLB-200 model loaded successfully!\n');
    console.log('🎉 Translation service is fully operational.\n');
    console.log('   Supports: English ↔ Arabic (and 200+ other languages)\n');
  } catch (error) {
    console.error('❌ Error loading model:', error.message);
    console.log('\n   Falling back to smaller opus-mt models...');
    
    // Fallback to opus-mt if NLLB fails
    try {
      translator = await pipeline('translation', 'Xenova/opus-mt-en-ar');
      console.log('   ✅ Fallback model loaded (opus-mt-en-ar)\n');
    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError.message);
    }
  }
  
  isLoading = false;
};

// Translation function using NLLB-200 model
const translateText = async (text, direction = 'en-ar') => {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return text;
  }

  try {
    return await translateSingleText(text, direction);
  } catch (error) {
    console.error('Translation error:', error.message);
    return text;
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'translation-model',
    model: 'NLLB-200-distilled-600M',
    modelLoaded: !!translator,
    cacheSize: translationCache.size,
    uptime: process.uptime()
  });
});

// Model status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    ready: !!translator,
    loading: isLoading,
    model: 'NLLB-200-distilled-600M',
    status: translator ? 'loaded' : 'not loaded'
  });
});

// Translate English to Arabic
app.post('/api/translate/en-ar', async (req, res) => {
  try {
    const { text, texts } = req.body;
    
    if (!translator) {
      return res.status(503).json({ 
        success: false, 
        error: 'Model still loading, please wait...',
        loading: isLoading 
      });
    }
    
    // Single text translation
    if (text) {
      const translated = await translateText(text, 'en-ar');
      return res.json({ success: true, translation: translated });
    }
    
    // Batch translation
    if (texts && Array.isArray(texts)) {
      const translations = await translateBatchTexts(texts, 'en-ar');
      return res.json({ success: true, translations });
    }
    
    return res.status(400).json({ success: false, error: 'No text provided' });
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Translate Arabic to English
app.post('/api/translate/ar-en', async (req, res) => {
  try {
    const { text, texts } = req.body;
    
    if (!translator) {
      return res.status(503).json({ 
        success: false, 
        error: 'Model still loading, please wait...',
        loading: isLoading 
      });
    }
    
    // Single text translation
    if (text) {
      const translated = await translateText(text, 'ar-en');
      return res.json({ success: true, translation: translated });
    }
    
    // Batch translation
    if (texts && Array.isArray(texts)) {
      const translations = await translateBatchTexts(texts, 'ar-en');
      return res.json({ success: true, translations });
    }
    
    return res.status(400).json({ success: false, error: 'No text provided' });
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generic translate endpoint
app.post('/api/translate', async (req, res) => {
  try {
    const { text, texts, from = 'en', to = 'ar' } = req.body;
    const direction = `${from}-${to}`;
    
    // Validate direction
    if (!['en-ar', 'ar-en'].includes(direction)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid language pair. Supported: en-ar, ar-en' 
      });
    }
    
    if (!translator) {
      return res.status(503).json({ 
        success: false, 
        error: 'Model still loading, please wait...',
        loading: isLoading 
      });
    }
    
    // Single text translation
    if (text) {
      const translated = await translateText(text, direction);
      return res.json({ success: true, translation: translated, from, to });
    }
    
    // Batch translation
    if (texts && Array.isArray(texts)) {
      const translations = await translateBatchTexts(texts, direction);
      return res.json({ success: true, translations, from, to });
    }
    
    return res.status(400).json({ success: false, error: 'No text provided' });
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cache stats endpoint
app.get('/api/cache/stats', (req, res) => {
  res.json({
    size: translationCache.size,
    maxSize: CACHE_MAX_SIZE,
    ttlHours: CACHE_TTL / (1000 * 60 * 60)
  });
});

// Clear cache endpoint
app.post('/api/cache/clear', (req, res) => {
  translationCache.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

// Start server and load models
app.listen(PORT, async () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║      Translation Model Service (LOCAL)                      ║
╠════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                               ║
║  Model: Meta NLLB-200 (Best Quality!)                      ║
║  Mode: LOCAL - No API key needed!                          ║
║                                                            ║
║  Endpoints:                                                ║
║  POST /api/translate/en-ar  - English to Arabic            ║
║  POST /api/translate/ar-en  - Arabic to English            ║
║  POST /api/translate        - Generic translation          ║
║  GET  /health               - Health check                 ║
║  GET  /api/status           - Model loading status         ║
╚════════════════════════════════════════════════════════════╝
  `);
  
  // Load model in background
  loadModels();
});

export default app;
