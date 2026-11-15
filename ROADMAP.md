# Roadmap

## Done

- [x] Style profile from past edits, saved once and loaded on every visit (v0.3)
- [x] Brief parsing: pick count + vibe words
- [x] Scene clustering on capture time + GPS, burst collapsing with embeddings
- [x] Scoring: taste, faces, sharpness, exposure, composition, color, look, brief
- [x] Pairwise taste ranker (This or That) + learning from manual picks and un-picks (v0.2)
- [x] Claude taste judge using your past posts as examples (artifact only) (v0.2)
- [x] In-browser face landmarks: eyes open, smile, head turn (v0.2)
- [x] Match my look edits faces only (v0.2)
- [x] Per-app cover framing around the face (v0.2)
- [x] Export photos (JPEG / zip) and covers

## Next

- [ ] Test with real shoots and tune the scoring weights and thresholds
- [ ] Extend face retouch: eyes, teeth, face shape, learned from past edits
- [ ] Manual crop nudge on cover previews
- [ ] Log which cover was posted + its views, to start learning real per-platform models
- [ ] Better "fits your look" signal: CLIP / SigLIP embeddings instead of hand-made features

## Later (public website)

- [ ] Host the front end (Vercel / Netlify / GitHub Pages)
- [ ] Small backend for Claude API calls (key stays server-side), with usage limits
- [ ] Accounts + profile storage (e.g. Supabase / Firebase)
- [ ] Privacy policy and consent for face data
- [ ] Connect Instagram / TikTok / Douyin accounts through official APIs for view data

## After that (phone app)

- [ ] Installable web app first, then native iOS / Android
- [ ] On-device culling of the camera roll
