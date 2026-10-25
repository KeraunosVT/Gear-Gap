// backend/vision.js — the one place this app talks to a vision model.
//
// Both screenshot readers (match scoreboards in ingest.js, the Equipment Level
// popup in gearIlvl.js) used to construct their own Gemini client, their own
// schema in Gemini's `Type` enums, and their own "did not return valid JSON"
// error. That was two copies of the same six lines, and swapping providers
// meant editing both and hoping they stayed in step. They didn't need to be
// separate; they needed a seam.
//
// Callers supply a prompt, some images and a JSON Schema. What model answers,
// and through which API, is this file's business and nobody else's. That seam
// is what let the provider go OpenAI and back to Gemini without either reader
// changing.
const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Model names churn — keep this swappable without a code change. Flash-Lite
// because every read here is transcription of printed text, and the build
// reader sends seven screenshots per member: at ~1¢ a build scan the whole
// guild re-scanning costs well under a dollar.
const VISION_MODEL = process.env.VISION_MODEL || 'gemini-3.5-flash-lite';

// Gemini 3 is steered by a thinking level rather than temperature (Google
// advises leaving temperature at its default for these models, which is why
// the old `temperature: 0` is gone). Reading a screenshot is transcription,
// not deduction: 'low' suits it, and raising it mostly buys latency and output
// tokens, which are the expensive half of the bill. Overridable because a
// persistently misread icon is worth an experiment.
const REASONING_EFFORT = process.env.VISION_REASONING_EFFORT || 'low';

// 'high' rather than the default. Every screenshot this reads is dense and
// small-featured — a scoreboard's weapon icons are a few dozen pixels each, and
// a build's stat panels are rows of small digits where 2,123.4 and 2,128.4 are
// different builds. Downsampling to save tokens would be saving money on the
// one thing being bought.
const IMAGE_DETAIL = process.env.VISION_IMAGE_DETAIL || 'high';
const MEDIA_RESOLUTION = {
  low: 'MEDIA_RESOLUTION_LOW',
  medium: 'MEDIA_RESOLUTION_MEDIUM',
  high: 'MEDIA_RESOLUTION_HIGH',
}[IMAGE_DETAIL] || 'MEDIA_RESOLUTION_HIGH';

let client;
function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  return client;
}

// Read one or more images against a schema, and return the parsed object.
//
// `images` is an array of { buffer, mimeType }, sent in the order given —
// callers that reference "Image 1" in their prompt are relying on that order.
//
// `schema` is a JSON Schema whose ROOT is an object, with every object listing
// its properties in `required` and setting `additionalProperties: false`. Gemini
// accepts that subset as-is (responseJsonSchema), so the readers' schemas did
// not have to change when the provider did. `schemaName` is kept for the
// readers' sake and for error messages; Gemini has no use for it.
//
// `unavailable` names the feature in the missing-key error, so a deployment
// without a key says which page just stopped working rather than "reading is
// unavailable" from somewhere unspecified.
async function readImages({ prompt, images, schema, schemaName, unavailable }) {
  if (!GEMINI_API_KEY) {
    throw new Error(`GEMINI_API_KEY is not set — ${unavailable} is unavailable.`);
  }

  const response = await getClient().models.generateContent({
    model: VISION_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        ...images.map(({ buffer, mimeType }) => ({
          inlineData: { mimeType, data: buffer.toString('base64') },
        })),
      ],
    }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      thinkingConfig: { thinkingLevel: REASONING_EFFORT.toUpperCase() },
      mediaResolution: MEDIA_RESOLUTION,
    },
  });

  try {
    return JSON.parse(response.text);
  } catch {
    // Deliberately not naming the provider: this is shown to members uploading
    // a screenshot, who can do nothing with it, and it goes stale the moment
    // the model behind this changes — which it already has, twice.
    console.error(`vision: ${schemaName} reply was not valid JSON`);
    throw new Error('The reader did not return valid JSON. Try a clearer screenshot.');
  }
}

module.exports = { readImages, VISION_MODEL };
