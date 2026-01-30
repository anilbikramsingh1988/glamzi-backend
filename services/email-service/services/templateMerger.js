import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Handlebars from "handlebars";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skeletonPath = path.resolve(__dirname, "..", "..", "templates", "transactional", "skeleton.mjml");

let cachedSkeleton = null;
let compiledSkeleton = null;

function loadSkeleton() {
  if (compiledSkeleton) return compiledSkeleton;
  cachedSkeleton = fs.readFileSync(skeletonPath, "utf-8");
  compiledSkeleton = Handlebars.compile(cachedSkeleton);
  return compiledSkeleton;
}

export function mergeTransactionalBlocks({ contentBlocks = {}, variables = {} }) {
  const skeleton = loadSkeleton();
  const safeBlocks = {
    headerText: contentBlocks.headerText || "",
    bodyText: contentBlocks.bodyText || "",
    ctaLabel: contentBlocks.ctaLabel || "",
    ctaUrl: contentBlocks.ctaUrl || "",
    footerText: contentBlocks.footerText || "",
    previewText: contentBlocks.previewText || "",
  };

  return skeleton({ ...variables, ...safeBlocks });
}
