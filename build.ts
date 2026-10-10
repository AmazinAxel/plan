// Copies public/ to dist/ (what wrangler uploads) with comments and whitespace
// stripped from everything the browser downloads, so the sources can stay
// thoroughly commented at no network cost. Run by wrangler before every
// deploy/dev (`build.command` in wrangler.jsonc).
import { cp, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await cp("public", "dist", { recursive: true });
const res = await Bun.build({
  entrypoints: ["public/app.js", "public/styles.css"],
  outdir: "dist",
  minify: true,
  external: ["/fonts/*"],
});
if (!res.success) throw new AggregateError(res.logs, "build failed");
const html = await readFile("public/index.html", "utf8");
await writeFile("dist/index.html", html.replace(/\s*<!--[\s\S]*?-->/g, ""));
