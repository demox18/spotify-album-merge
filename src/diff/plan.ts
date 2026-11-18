import { ADD_BATCH_SIZE } from '../constants';

export interface MembershipDiff {
  alreadyPresent: string[];
  missing: string[];
  batches: string[][];
}

/** Differenza tra gli URI confermati e quelli già in playlist. Non riordina il resto. */
export function membershipDiff(
  intendedUris: readonly string[],
  presentUris: Iterable<string>,
  batchSize = ADD_BATCH_SIZE,
): MembershipDiff {
  if (batchSize < 1 || batchSize > ADD_BATCH_SIZE) {
    throw new Error(`Batch non valido: massimo ${ADD_BATCH_SIZE}.`);
  }
  const present = presentUris instanceof Set ? presentUris : new Set(presentUris);
  const alreadyPresent: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const uri of intendedUris) {
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    if (present.has(uri)) alreadyPresent.push(uri);
    else missing.push(uri);
  }
  const batches: string[][] = [];
  for (let index = 0; index < missing.length; index += batchSize) {
    batches.push(missing.slice(index, index + batchSize));
  }
  return { alreadyPresent, missing, batches };
}

export interface MembershipVerification {
  present: string[];
  missing: string[];
  complete: boolean;
}

export function verifyMembership(
  intendedUris: readonly string[],
  presentUris: Iterable<string>,
): MembershipVerification {
  const presentSet = presentUris instanceof Set ? presentUris : new Set(presentUris);
  const seen = new Set<string>();
  const present: string[] = [];
  const missing: string[] = [];
  for (const uri of intendedUris) {
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    if (presentSet.has(uri)) present.push(uri);
    else missing.push(uri);
  }
  return { present, missing, complete: missing.length === 0 };
}

/** Corpo di POST /playlists/{id}/items. Senza position: Spotify accoda. */
export function addItemsBody(uris: readonly string[]): { uris: string[] } {
  if (uris.length < 1 || uris.length > ADD_BATCH_SIZE) {
    throw new Error(`Un batch contiene da 1 a ${ADD_BATCH_SIZE} URI.`);
  }
  return { uris: [...uris] };
}
