// Vision call for photo analysis.
//
// The prompt and response schema live in core/analysis/prompt.js so the
// Android app can send exactly the same request; only transport belongs here.

import { buildPrompt, RESPONSE_SCHEMA, buildLeftoversPrompt, LEFTOVERS_SCHEMA } from '../core/analysis/prompt.js';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export const getModel = () => (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const getKey = () => (process.env.GEMINI_API_KEY || '').trim();

export const isConfigured = () => Boolean(getKey());

export class AnalysisError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Sends one photo and returns the parsed model response plus token usage.
 *
 * Usage is returned because it is the only way to know what the feature
 * actually costs per meal; the measured figure was $0.0011, and that should be
 * observable in production rather than assumed from a one-off probe.
 */
export async function analysePhoto(imageBase64, mimeType = 'image/jpeg', correction = null, locale = 'en') {
  return call(
    [
      { inline_data: { mime_type: mimeType, data: imageBase64 } },
      { text: buildPrompt(correction, locale) }
    ],
    RESPONSE_SCHEMA
  );
}

/**
 * The same plate before and after, read for what was left.
 *
 * Both photographs go in one request rather than two, because the question is
 * a comparison: asking about the second alone would be asking the model to
 * re-estimate a portion it can no longer see whole.
 *
 * The order matters and is stated in the prompt -- before, then after -- since
 * nothing in the images themselves says which way round time ran.
 */
export async function readLeftovers(beforeBase64, afterBase64, mimeType, items, locale = 'en') {
  return call(
    [
      { text: 'Before eating:' },
      { inline_data: { mime_type: mimeType, data: beforeBase64 } },
      { text: 'After eating:' },
      { inline_data: { mime_type: 'image/jpeg', data: afterBase64 } },
      { text: buildLeftoversPrompt(items, locale) }
    ],
    LEFTOVERS_SCHEMA
  );
}

async function call(parts, schema) {
  const key = getKey();
  if (!key) {
    throw new AnalysisError('not_configured', 'Photo analysis is not configured on this server.', 503);
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.2,
      maxOutputTokens: 4096
    }
  };

  let res;
  try {
    res = await fetch(`${ENDPOINT_BASE}${encodeURIComponent(getModel())}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });
  } catch (err) {
    // A timeout or DNS failure is ours, not the user's, and is retryable.
    throw new AnalysisError('upstream_unreachable',
      'Could not reach the analysis service. Try again in a moment.', 503);
  }

  if (res.status === 429) {
    throw new AnalysisError('rate_limited', 'Too many photos at once. Try again shortly.', 429);
  }
  if (!res.ok) {
    let detail = `status ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error?.message) detail = j.error.message;
    } catch {}
    throw new AnalysisError('upstream_error', `Analysis failed: ${detail}`, 502);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AnalysisError('empty_response', 'The analysis came back empty. Try another photo.', 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(text.replace(/```json\s*|\s*```/g, '').trim());
    } catch {
      throw new AnalysisError('unparseable', 'The analysis could not be read. Try again.', 502);
    }
  }

  const u = json.usageMetadata || {};
  return {
    raw: parsed,
    usage: {
      promptTokens: u.promptTokenCount ?? null,
      outputTokens: u.candidatesTokenCount ?? null
    },
    model: getModel()
  };
}
