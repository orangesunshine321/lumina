import { nanoid } from "nanoid";

/** ~125 bits of entropy — used for every externally-facing or primary-key id
 * (gallery slugs, gallery ids, photo ids). Never sequential, so a leaked id
 * can't be walked to enumerate other records. */
export function generateId(): string {
  return nanoid(21);
}

export function generateSlug(): string {
  return nanoid(21);
}
