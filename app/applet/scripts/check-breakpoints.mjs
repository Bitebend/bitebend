import fs from "fs";
import path from "path";

const dir = "lib/db/drizzle";
const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();

for (const f of files) {
  const content = fs.readFileSync(path.join(dir, f), "utf8");
  const pieces = content.split("--> statement-breakpoint");
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    let inDollar = false;
    let inQuote = false;
    let semiCount = 0;
    const lines = piece.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("--")) continue;
      for (let j = 0; j < line.length; j++) {
        if (line[j] === "'" && !inDollar) inQuote = !inQuote;
        else if (line.slice(j, j + 2) === "$$") { inDollar = !inDollar; j++; }
        else if (line[j] === ";" && !inQuote && !inDollar) semiCount++;
      }
    }
    if (semiCount > 1) {
      console.log(`File ${f} piece ${i} has ${semiCount} statements`);
    }
  }
}
