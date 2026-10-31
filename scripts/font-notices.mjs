import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packages = ["noto-sans", "noto-sans-sc", "noto-sans-jp"];
const notices = [
    "VRCLearn Store — Noto font licenses",
    "These fonts retain their OFL-1.1 licenses. The application's AGPL-3.0-only license does not replace them.",
];
for (const name of packages) {
    const directory = new URL(`node_modules/@fontsource-variable/${name}/`, root);
    const metadata = JSON.parse(await readFile(new URL("package.json", directory), "utf8"));
    if (metadata.license !== "OFL-1.1") throw new Error(`Review the font license before distributing ${metadata.name}.`);
    const license = (await readFile(new URL("LICENSE", directory), "utf8")).split(/\r?\n/).map((line) => line.trimEnd()).join("\n").trim();
    notices.push(`${metadata.name}@${metadata.version}\nLicense: ${metadata.license}\n\n${license}`);
}
await writeFile(new URL("public/font-licenses.txt", root), `${notices.join("\n\n")}\n`);
