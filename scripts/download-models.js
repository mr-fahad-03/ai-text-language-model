/**
 * Model Download Script
 * Downloads all required translation models from Hugging Face
 * Run: npm run download-models
 */

import { pipeline, env } from '@xenova/transformers';
import fs from 'fs';
import path from 'path';

// Configure cache directory
env.cacheDir = './models';
env.allowLocalModels = true;

const MODELS = [
  {
    name: 'NLLB-200 (Main Model)',
    task: 'translation',
    model: 'Xenova/nllb-200-distilled-600M',
    size: '~600MB'
  },
  {
    name: 'Opus MT English to Arabic',
    task: 'translation',
    model: 'Xenova/opus-mt-en-ar',
    size: '~100MB'
  },
  {
    name: 'Opus MT Arabic to English',
    task: 'translation',
    model: 'Xenova/opus-mt-ar-en',
    size: '~100MB'
  }
];

async function downloadModels() {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 AI Translation Model Downloader');
  console.log('='.repeat(60));
  console.log('\nThis will download all required translation models.');
  console.log('Total size: ~800MB - 1GB');
  console.log('Please wait, this may take several minutes...\n');

  // Create models directory if it doesn't exist
  const modelsDir = path.resolve('./models');
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
    console.log('📁 Created models directory\n');
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < MODELS.length; i++) {
    const modelInfo = MODELS[i];
    console.log(`\n[${i + 1}/${MODELS.length}] Downloading: ${modelInfo.name}`);
    console.log(`   Model: ${modelInfo.model}`);
    console.log(`   Size: ${modelInfo.size}`);
    console.log('-'.repeat(50));

    try {
      const startTime = Date.now();
      
      await pipeline(modelInfo.task, modelInfo.model, {
        progress_callback: (progress) => {
          if (progress.status === 'downloading') {
            const pct = Math.round((progress.loaded / progress.total) * 100);
            const loaded = (progress.loaded / 1024 / 1024).toFixed(1);
            const total = (progress.total / 1024 / 1024).toFixed(1);
            process.stdout.write(`\r   📥 Downloading: ${pct}% (${loaded}MB / ${total}MB)    `);
          } else if (progress.status === 'loading') {
            process.stdout.write(`\r   ⏳ Loading model...                              `);
          }
        }
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n   ✅ Downloaded successfully in ${elapsed}s`);
      successCount++;
    } catch (error) {
      console.log(`\n   ❌ Failed to download: ${error.message}`);
      failCount++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 Download Summary');
  console.log('='.repeat(60));
  console.log(`   ✅ Successful: ${successCount}/${MODELS.length}`);
  if (failCount > 0) {
    console.log(`   ❌ Failed: ${failCount}/${MODELS.length}`);
  }
  
  if (successCount === MODELS.length) {
    console.log('\n🎉 All models downloaded successfully!');
    console.log('   You can now start the server with: npm start\n');
  } else if (successCount > 0) {
    console.log('\n⚠️  Some models failed to download.');
    console.log('   The server will still work with available models.');
    console.log('   Run this script again to retry failed downloads.\n');
  } else {
    console.log('\n❌ All downloads failed. Please check your internet connection.');
    console.log('   You may need to run: npm run download-models\n');
    process.exit(1);
  }
}

// Run the download
downloadModels().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
