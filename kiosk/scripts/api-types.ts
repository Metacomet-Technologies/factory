import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import openapiTS, { astToString } from "openapi-typescript";

export async function apiTypes(check = false) {
  const url = new URL(process.env.OPENAPI_URL ?? "http://127.0.0.1:8080/openapi.json");
  const output = "src/api/generated.ts";
  const source = execFileSync("vp", ["fmt", `--stdin-filepath=${output}`], {
    input: astToString(await openapiTS(url)),
    encoding: "utf8",
  });
  if (check) {
    if ((await readFile(output, "utf8")) !== source)
      throw new Error("Live OpenAPI has changed. Run vp run api:types, then vp check.");
  } else {
    await writeFile(output, source);
  }
}
if (import.meta.main) await apiTypes(process.argv.includes("--check"));
