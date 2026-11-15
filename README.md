# Loupe

Cull, edit and cover. Loupe picks the best photos from a shoot, retouches faces the way you do, and recommends the best cover for each platform (Instagram, TikTok, Douyin, Xiaohongshu).

Built for creators (Gen Z, Gen Alpha) and the entertainment industry.

**Live prototype (Claude artifact, invite only):** https://claude.ai/artifact/U3jDFajm2Ggiphw8AfJQUB

## How it works

1. **Your look:** upload past edited photos once. Loupe learns your face retouching (skin brightness, warmth, smoothness) and your overall style, and saves the profile for next time.
2. **New shoot:** drop a whole shoot with a short brief, like "6 picks, warm film vibe, no closed eyes".
3. **Pick:** photos are grouped into scenes by capture time and GPS, near-duplicate bursts are collapsed, and every frame is scored on your taste, faces (eyes open, smile, head turn), sharpness, exposure, framing and color. Picks learn from This or That and from every pick or un-pick you make.
4. **Edit:** Match my look retouches faces only, to match your past edits. Manual sliders handle the rest.
5. **Cover:** each pick is reframed per app around the face (eye height, face size, UI safe zones, title space) and ranked on what that feed rewards.

The full design, including what changes for production, is in [`app/blueprint.html`](app/blueprint.html) (also linked as "How it works" in the app).

## Run it locally

No build step. Serve the `app` folder and open it in a browser:

```bash
python3 -m http.server 5178 -d app
```

Then open http://localhost:5178. The app opens with a sample profile and a sample shoot so you can click through every step.

If your browser caches old JavaScript while you edit, hard-reload (Cmd+Shift+R).

### What only works inside the Claude artifact

The published artifact gets two extra abilities from claude.ai:

- **Claude judging:** taste and face scoring that compares each frame with your past posts.
- **Account-synced profile:** saved privately to your Claude account, so it follows you to other devices.

Run locally (or on any other host), Loupe falls back to in-browser scoring and saves the profile in that browser. Everything else works the same.

## Project layout

```
app/
  index.html        page, styles, layout
  blueprint.html    product + architecture doc
  js/
    app.js          UI and workflow (all five steps)
    engine.js       profile, brief parsing, clustering, bursts, scoring, ranker, selection
    analyze.js      per-photo measurements, embeddings, skin stats
    faces.js        face detection + 68 landmarks (face-api / TF.js)
    edit.js         face-only retouch, manual adjustments (3D LUT), grain
    covers.js       per-platform framing and cover ranking
    vault.js        saved profile (Claude account db, or browser IndexedDB)
    exif.js         capture time, camera, GPS
    demo.js         procedurally drawn sample photos
  models/           face detector + landmark weights (JSON)
ROADMAP.md          ideas and next steps
```

## Working together

- **Branch for each change:** `git switch -c your-name/short-description`, commit, push, and open a pull request. The other person reviews before merging into `main`.
- **Ideas and bugs** go in GitHub Issues, or in [`ROADMAP.md`](ROADMAP.md) for bigger direction.
- **Never commit real photos, API keys or `.env` files.** Use the sample shoot for testing.
- **Publishing:** `main` is the source of truth. When a version is ready, publish it to the artifact link (ask Claude Code to republish `app/index.html` with its `js/` and `models/` files to the URL above).

## Credits

Face detection uses [@vladmandic/face-api](https://github.com/vladmandic/face-api) (MIT), loaded from jsDelivr, with its model weights repacked as JSON in `app/models/`. Zipping uses [JSZip](https://stuk.github.io/jszip/) (MIT).
