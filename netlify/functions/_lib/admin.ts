/* =====================================================================
   Firebase Admin, initialised once per warm function instance.

   The project is on the Spark plan, so Cloud Functions would mean
   upgrading to Blaze. These run on Netlify instead, where the calendar
   app already deploys — with the service account key in environment
   variables and nowhere else. A leaked key is full database write
   access, so it never appears in client code, in the repo, or in a
   response body.
   ===================================================================== */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let cached: App | null = null;

function app(): App {
  if (cached) return cached;
  const existing = getApps();
  if (existing.length > 0) {
    cached = existing[0]!;
    return cached;
  }

  // Local development: drop the downloaded JSON in as
  // serviceAccountKey.json (gitignored) and nothing needs copying into a
  // file by hand. Deployed, the environment variables are the only path —
  // the key file never exists on Netlify.
  const local = localKey();
  if (local) {
    cached = initializeApp({ credential: cert(local), projectId: local.projectId });
    return cached;
  }

  const projectId = requireEnv("FIREBASE_PROJECT_ID");
  const clientEmail = requireEnv("FIREBASE_CLIENT_EMAIL");
  // Netlify stores the key as a single line; the JSON file has real
  // newlines. Accept either rather than depending on how it was pasted.
  const privateKey = requireEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  cached = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
  return cached;
}

function localKey(): { projectId: string; clientEmail: string; privateKey: string } | null {
  const path = process.env.FIREBASE_KEY_FILE ?? "serviceAccountKey.json";
  try {
    const raw = readFileSync(resolve(process.cwd(), path), "utf8");
    const json = JSON.parse(raw) as {
      project_id?: string; client_email?: string; private_key?: string;
    };
    if (!json.project_id || !json.client_email || !json.private_key) return null;
    return {
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey: json.private_key
    };
  } catch {
    // Absent is the normal case in production, not an error.
    return null;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function db(): Firestore {
  return getFirestore(app());
}

