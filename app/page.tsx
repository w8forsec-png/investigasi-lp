import { readFile } from "node:fs/promises";
import path from "node:path";

export default async function HomePage() {
  const htmlPath = path.join(process.cwd(), "public", "index.html");
  const document = await readFile(htmlPath, "utf8");
  const body = document.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];

  if (!body) {
    throw new Error("Konten dashboard tidak ditemukan di public/index.html.");
  }

  return <div dangerouslySetInnerHTML={{ __html: body }} />;
}
