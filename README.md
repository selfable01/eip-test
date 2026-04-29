# 3Zebra Timed Context Engine

A video analysis tool that downloads YouTube videos, uploads them to Google Gemini, and generates AI-powered breakdowns including hook, pain point, and show structure analysis.

## Features

- Paste a YouTube URL to download and analyze videos
- Uses **yt-dlp** for video downloading
- Uploads video to **Google Gemini** (File API) for multimodal analysis
- Generates structured video breakdowns via Gemini AI
- Dark-themed, responsive single-page UI
- Deployable locally or on **Vercel** (serverless)

## Prerequisites

- Node.js 18+
- A [Gemini API key](https://ai.google.dev/)
- `yt-dlp` binary (`yt-dlp.exe` on Windows, auto-downloaded on Linux/Vercel)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file in the project root:

   ```
   GEMINI_API_KEY=your_api_key_here
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Open `http://localhost:3000` in your browser.

## Deployment

Configured for Vercel with `vercel.json`. Serverless functions in `api/` handle video upload and AI generation with extended timeouts (300s) and 1 GB memory.

## Tech Stack

- **Backend:** Express 5, Google Generative AI SDK
- **Frontend:** Vanilla HTML/CSS/JS (single-page)
- **AI Model:** Gemini 2.5 Flash
- **Video Download:** yt-dlp
