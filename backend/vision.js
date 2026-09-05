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
// and through which API, is this file's business and nobody else's.
const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Model names churn — keep this swappable without a code change.
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-5.6-terra';

// gpt-5.6-terra is a REASONING model, so it is steered by effort rather than by
// temperature — the old `temperature: 0` has no equivalent here and passing it
// is rejected. Reading a scoreboard is transcription, not deduction: 'low' is
// the level that suits it, and raising it mostly buys latency and output
// tokens. Overridable because "mostly" is not "always" — a persistently
// misread icon is worth an experiment.
const REASONING_EFFORT = process.env.VISION_REASONING_EFFORT || 'low';

// 'high' rather than the default 'auto'. Both screenshots this reads are dense
// and small-featured — a scoreboard's weapon icons are a few dozen pixels each,
// and the whole reason the prompt carries ten bullets of icon disambiguation is
// that they are hard to tell apart. Downsampling them to save tokens would be
// saving money on the one thing being bought.
const IMAGE_DETAIL = process.env.VISION_IMAGE_DETAIL || 'high';

let client;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return client;
}

// Read one or more images against a schema, and return the parsed object.
//
// `images` is an array of { buffer, mimeType }, sent in the order given —
// callers that reference "Image 1" in their prompt are relying on that order.
//
// `schema` must be a STRICT-mode JSON Schema: every object needs
// `additionalProperties: false` and must list every one of its properties in
// `required`, and the ROOT must be an object. A bare array root is rejected,
// which is why the scoreboard reader wraps its rows in a `players` key.
//
// `unavailable` names the feature in the missing-key error, so a deployment
// without a key says which page just stopped working rather than "reading is
// unavailable" from somewhere unspecified.
async function readImages({ prompt, images, schema, schemaName, unavailable }) {
  if (!OPENAI_API_KEY) {
    throw new Error(`OPENAI_API_KEY is not set — ${unavailable} is unavailable.`);
  }

  const response = await getClient().responses.create({
    model: VISION_MODEL,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        ...images.map(({ buffer, mimeType }) => ({
          type: 'input_image',
          image_url: `data:${mimeType};base64,${buffer.toString('base64')}`,
          detail: IMAGE_DETAIL,
        })),
      ],
    }],
    text: {
      format: { type: 'json_schema', name: schemaName, strict: true, schema },
    },
    reasoning: { effort: REASONING_EFFORT },
  });

  try {
    return JSON.parse(response.output_text);
  } catch {
    // Deliberately not naming the provider. The previous wording said "Gemini
    // did not return valid JSON", which was shown to officers uploading a
    // screenshot — a detail they can do nothing with, and one that goes stale
    // the moment the model behind this changes.
    throw new Error('The reader did not return valid JSON. Try a clearer screenshot.');
  }
}

module.exports = { readImages, VISION_MODEL };
