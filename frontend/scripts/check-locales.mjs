// Every English key must exist in hi/te with the same {{placeholders}} (catalog.* names are extra by design).
import { readFileSync } from "node:fs";

const load = (name) => JSON.parse(readFileSync(new URL(`../src/locales/${name}.json`, import.meta.url), "utf8"));
const flat = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([key, value]) =>
    typeof value === "object" ? flat(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
  );
const holes = (text) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(",");

const en = new Map(flat(load("en")));
let problems = 0;
for (const lang of ["hi", "te"]) {
  const other = new Map(flat(load(lang)));
  for (const [key, text] of en) {
    if (!other.has(key)) {
      console.log(`${lang}: missing ${key}`);
      problems++;
    } else if (holes(text) !== holes(other.get(key))) {
      console.log(`${lang}: placeholders differ in ${key}: [${holes(text)}] vs [${holes(other.get(key))}]`);
      problems++;
    }
  }
  const extra = [...other.keys()].filter((key) => !en.has(key) && !key.startsWith("catalog."));
  if (extra.length) console.log(`${lang}: keys not in English: ${extra.join(", ")}`);
  console.log(`${lang}: ${other.size} keys checked`);
}
console.log(problems ? `${problems} problems` : "OK");
