// Read-only Google Drive access for the watched folder. Uses the same Google OAuth client as YouTube,
// with its own sign-in (scope drive.readonly): FreePoster never changes anything in Drive.
import { Readable } from "node:stream";
import { config } from "../config.ts";
import { pkceChallenge } from "../crypto.ts";
import { FatalError, request, requestJson } from "../http.ts";
import { expiresIn } from "../platforms/base.ts";

const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export interface DriveTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Drive fills this in once the upload is complete */
  md5Checksum?: string;
  createdTime: string;
}

const creds = () => config.credentials.youtube;
/** Drive's upload time in ms, or null if it's missing or unreadable */
export const uploadedAt = (f: Pick<DriveFile, "createdTime">) => {
  const t = Date.parse(f.createdTime);
  return Number.isFinite(t) ? t : null;
};

export const driveRedirectUri = () => config.redirectPage || `${config.baseUrl}/callback/drive`;

/** "https://drive.google.com/drive/folders/<id>?usp=sharing" or a bare id → the id. */
export function folderIdFrom(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = /\/folders\/([\w-]{10,})/.exec(trimmed)?.[1] ?? /[?&]id=([\w-]{10,})/.exec(trimmed)?.[1];
  const id = fromUrl ?? trimmed;
  return /^[\w-]{10,}$/.test(id) ? id : null;
}

export function driveAuthorizeUrl(state: string, verifier: string): string {
  const q = new URLSearchParams({
    client_id: creds().id,
    redirect_uri: driveRedirectUri(),
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeDriveCode(code: string, verifier: string): Promise<{ tokens: DriveTokens; email: string }> {
  const t = await requestJson(TOKEN, {
    form: {
      code,
      client_id: creds().id,
      client_secret: creds().secret,
      redirect_uri: driveRedirectUri(),
      grant_type: "authorization_code",
      code_verifier: verifier,
    },
  });
  if (!t.refresh_token) throw new FatalError("Google returned no refresh token; remove FreePoster's access at myaccount.google.com/permissions and connect again");
  const about = await requestJson(`${API}/about?fields=user(emailAddress)`, { headers: { authorization: `Bearer ${t.access_token}` } });
  return {
    tokens: { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresIn(t.expires_in) },
    email: about.user?.emailAddress ?? "",
  };
}

export async function refreshDrive(tokens: DriveTokens): Promise<DriveTokens> {
  const t = await requestJson(TOKEN, {
    form: { client_id: creds().id, client_secret: creds().secret, refresh_token: tokens.refreshToken, grant_type: "refresh_token" },
  });
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? tokens.refreshToken, expiresAt: expiresIn(t.expires_in) };
}

/** Every video in the folder (not in the trash). Shared folders and shared drives work too. */
export async function listFolder(token: string, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false and mimeType contains 'video/'`,
      fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,createdTime)",
      pageSize: "100",
      orderBy: "createdTime",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const page = await requestJson(`${API}/files?${q}`, { headers: { authorization: `Bearer ${token}` } });
    for (const f of page.files ?? []) files.push({ ...f, size: Number(f.size ?? 0) });
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return files;
}

export async function downloadFile(token: string, id: string): Promise<Readable> {
  const res = await request(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.body) throw new Error("Drive sent an empty file");
  return Readable.fromWeb(res.body as any);
}
