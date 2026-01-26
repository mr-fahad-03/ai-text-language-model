# 🌐 AI Text Language Model

A high-performance translation microservice for **English ↔ Arabic** translation using Xenova/Transformers.js with ONNX models for fast, offline inference.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![License](https://img.shields.io/badge/License-MIT-blue)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)

## ✨ Features

- 🚀 **Fast Translation** - ONNX quantized models for optimal performance
- 🔄 **Bidirectional** - English to Arabic & Arabic to English
- 📦 **Batch Support** - Translate multiple texts in a single request
- 🌍 **Multilingual** - NLLB-200 model for 200+ language pairs
- 💻 **Offline Ready** - No internet required after model download
- ⚡ **REST API** - Easy integration with any application

## 📋 Prerequisites

- Node.js 18 or higher
- npm or yarn
- ~1.5GB disk space for models

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/mr-fahad-03/ai-text-language-model.git
cd ai-text-language-model
```

### 2. Install & Download Models (One Command!)

```bash
npm install
```

This will automatically:
- Install all dependencies
- Download all translation models (~1GB)

> ⏱️ First install takes 5-10 minutes depending on your internet speed.

### 3. Start the Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

The server will start on `http://localhost:5001`

## ⚙️ Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TRANSLATION_PORT` | Server port | `5001` |
| `HF_API_KEY` | Hugging Face API key (optional) | `null` |

Create a `.env` file:
```env
TRANSLATION_PORT=5001
HF_API_KEY=your_api_key_here
```

## 📡 API Reference

### Health Check
```http
GET /health
```
**Response:**
```json
{ "status": "ok", "timestamp": "2024-01-01T00:00:00.000Z" }
```

### Translate English → Arabic
```http
POST /api/translate/en-ar
Content-Type: application/json

{ "text": "Hello World" }
```
**Response:**
```json
{ "success": true, "translation": "مرحبا بالعالم" }
```

### Translate Arabic → English
```http
POST /api/translate/ar-en
Content-Type: application/json

{ "text": "مرحبا بالعالم" }
```
**Response:**
```json
{ "success": true, "translation": "Hello World" }
```

### Generic Translation
```http
POST /api/translate
Content-Type: application/json

{ "text": "Hello", "from": "en", "to": "ar" }
```
**Response:**
```json
{ "success": true, "translation": "مرحبا", "from": "en", "to": "ar" }
```

### Batch Translation
```http
POST /api/translate/en-ar
Content-Type: application/json

{ "texts": ["Hello", "World", "Welcome"] }
```
**Response:**
```json
{ "success": true, "translations": ["مرحبا", "العالم", "أهلا وسهلا"] }
```

## 🖥️ Deployment

### Using PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start ecosystem.config.json

# Or manually
pm2 start server.js --name translation-service

# Save PM2 process list
pm2 save

# Enable startup on boot
pm2 startup
```

## 📁 Project Structure

```
ai-text-language-model/
├── server.js              # Main server file
├── package.json           # Dependencies
├── ecosystem.config.json  # PM2 configuration
├── .gitignore            # Git ignore rules
├── README.md             # Documentation
└── models/               # Downloaded models (not in repo)
    └── Xenova/
        ├── nllb-200-distilled-600M/
        ├── opus-mt-ar-en/
        └── opus-mt-en-ar/
```

## 🤖 Model Information

| Model | Size | Languages | Use Case |
|-------|------|-----------|----------|
| `opus-mt-en-ar` | ~100MB | EN → AR | English to Arabic |
| `opus-mt-ar-en` | ~100MB | AR → EN | Arabic to English |
| `nllb-200-distilled-600M` | ~900MB | 200+ langs | Multilingual |

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License.

## 👨‍💻 Author

**Muhammad Fahad**
- GitHub: [@mr-fahad-03](https://github.com/mr-fahad-03)

---

⭐ Star this repo if you find it helpful!
