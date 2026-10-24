# Playlists

Forty-two original instrumental tracks in four sets, hosted with the listening booth at
<https://ehartye.github.io/agent-beeps/playlists/>:

| Set | Tempo | Level | For |
|---|---|---|---|
| Dinner Party (`hosting`) | 60 to 108 bpm | -22 LUFS | Cooking for guests and the evening that follows. Talk comes first: soft timbres, no hook. |
| Deep Focus (`focus`) | 56 to 84 bpm | -24 LUFS | Study and work. Steady, no lyrics, one layer changes at a time. |
| Get Pumped (`pump`) | 118 to 150 bpm | -16 LUFS | Warming up, pushing and cooling down. Hard kick, driving bass, build and drop. |
| Tribute Album (`tribute`) | 90 to 174 bpm | -17 LUFS | Twelve tracks in the spirit of six electronic artists, on a new synth palette (supersaws, growls, wobbles, reese). No melody, sample or recording is reused. |

Every track is a plain `beeps/song@1` score in `songs/<set>/`. Nothing is sampled. `sets.json` holds each
set's title, brief, sources, running order and loudness target.

## Rebuild

```text
node scripts/render-playlists.mjs [--set hosting|focus|pump|tribute] [--only name,name]   # render scores to media/*.mp3, media/*.png, tracks.json
node scripts/render-playlists.mjs --seal                                          # hash everything into manifest.json
npm run showcase:build                                                            # verifies the manifest and copies the page to _site/playlists/
```

Rendering needs Chromium and ffmpeg (`npm install` provides both). The site build only verifies and copies the
committed results, as it does for the booth. After editing a score, render and then seal; the build refuses a file
whose hash is not the sealed one.
