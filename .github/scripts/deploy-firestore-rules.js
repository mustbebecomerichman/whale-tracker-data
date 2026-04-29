const crypto = require('crypto');
const fs = require('fs');

const projectId = process.env.FIREBASE_PROJECT_ID || 'whaletracker-pro';
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!credentialsPath) {
  throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required.');
}

const serviceAccount = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
const rulesContent = fs.readFileSync('firestore.rules', 'utf8');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(payload) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify(payload));
  const body = `${header}.${claims}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(body)
    .sign(serviceAccount.private_key, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${body}.${signature}`;
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`OAuth token request failed: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

async function firebaserules(method, path, token, body) {
  const response = await fetch(`https://firebaserules.googleapis.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, text);
  }
  return text ? JSON.parse(text) : {};
}

async function main() {
  if (serviceAccount.project_id !== projectId) {
    throw new Error(`Service account project_id must be ${projectId}, got ${serviceAccount.project_id}`);
  }

  console.log(`Deploying Firestore rules as ${serviceAccount.client_email}`);
  const token = await getAccessToken();
  const ruleset = await firebaserules('POST', `projects/${projectId}/rulesets`, token, {
    source: {
      files: [{ name: 'firestore.rules', content: rulesContent }],
    },
  });
  console.log(`Created ruleset ${ruleset.name}`);

  const releaseName = `projects/${projectId}/releases/cloud.firestore`;
  const release = { name: releaseName, rulesetName: ruleset.name };
  try {
    await firebaserules('PATCH', releaseName, token, {
      release,
      updateMask: 'rulesetName',
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      throw error;
    }
    await firebaserules('POST', `projects/${projectId}/releases`, token, release);
  }
  console.log(`Updated ${releaseName} to ${ruleset.name}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
