# Voice Interviewer Kit

Zero-dependency (Node 18+) scaffold for the Paytm × AI Garage Voice AI Buildathon.

## Run (2 minutes)
```bash
cp .env.example .env     # add ANTHROPIC_API_KEY (or OPENAI_API_KEY + LLM_PROVIDER=openai)
node server.js           # open http://localhost:3000 in Chrome
```

## First principles: what is a voice interviewer?

A loop with five parts. Everything in the hackathon is a tweak to one of these.

```
 mic ─► [1 STT] ─► text ─► [2 BRAIN: state + next question] ─► text ─► [3 TTS] ─► speaker
                               │
                               └─► [4 STATE: slots filled/missing] ─► [5 OUTPUT: structured brief]
```

1. **STT** (speech→text): here the browser's `SpeechRecognition` (free, Chrome). Pause 1.4s = end of turn (`flushTimer` in `public/index.html`).
2. **Brain** (`/api/turn`): each turn the LLM gets the transcript + current slot state and returns JSON: updated slots, sensitive items, the next spoken line, and `done`.
   This is what makes it an *interviewer* and not a questionnaire. It reasons about what's missing.
3. **TTS**: browser `speechSynthesis` (free, robotic). Upgrade path: ElevenLabs/OpenAI TTS (see "Upgrades").
4. **State**: "slots" = the info you need. Each has `status` (empty/partial/stated/inferred/unknown) and an evidence quote.
5. **Output** (`/api/brief`): a second, stronger-model pass over the whole transcript to produce the structured brief, with facts vs assumptions, missing info, sensitive items, and audience versions.

Why two models: turns must be fast (Haiku-class, ~1s). The final brief can take longer (Sonnet-class).

## Where to change things tomorrow

| Want to…                                   | Edit                                                    |
|--------------------------------------------|---------------------------------------------------------|
| New use case / different questions         | copy `usecases/form-interviewer.js`, register in `usecases/index.js` |
| Change interviewing style / follow-up rules| `TURN_RULES` in `server.js`                             |
| Change output shape                        | `briefSystem()` in `server.js` + `showTab()` in the UI  |
| Different audiences / versions             | `audiences` in the use case file                        |
| Different models                           | `.env` (`TURN_MODEL`, `BRIEF_MODEL`)                    |

## Known limits (be honest in the demo)
- Browser STT is Chrome/Edge only and sometimes mishears; typing is the fallback.
- With speakers on, the mic would hear the agent, so the mic pauses while it speaks. Use **headphones mode** to enable interrupting.
- Not tested against a live LLM key yet; do one full run tonight (see checklist).

## Upgrades if time allows (in order of impact)
1. Better voice: add a `/api/tts` endpoint calling ElevenLabs/OpenAI TTS and play the audio instead of `speechSynthesis`.
2. Better STT: Deepgram/Whisper streaming for accuracy and non-Chrome browsers.
3. Persist sessions (JSON file or SQLite) and add a shareable link for the brief.
4. Hand-off action: post the approved brief to Slack/Notion/email/n8n webhook.
5. Phone calling via Vapi/Retell/Twilio (only if the brief asks for it).

## Tonight's checklist
- [ ] Put a key in `.env`, run a full interview, press Finish. Fix anything that breaks.
- [ ] Interview it as 3 personas: vague, rambling, guarded. Tune `TURN_RULES`.
- [ ] Try interrupting it with headphones mode on.
- [ ] Record a 60-second screen capture as a demo backup.
