import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const outputDir = new URL("./公司报表/", import.meta.url);
const data = JSON.parse(await fs.readFile(new URL("./team-usage-data.json", import.meta.url), "utf8"));
const expectedByCompany = new Map((data.companies || []).map((company) => [company.name, company]));

for (const file of (await fs.readdir(outputDir)).filter((name) => name.endsWith(".xlsx")).sort()) {
  const companyName = [...expectedByCompany.keys()].find((name) => file.includes(`-${name}公司-`));
  if (!companyName) throw new Error(`无法从文件名识别公司: ${file}`);
  const expected = expectedByCompany.get(companyName);
  const path = decodeURIComponent(new URL(file, outputDir).pathname).replace(/^\/(\w:)/, "$1");
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(path));
  const sheets = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 5000 });
  const header = await workbook.inspect({
    kind: "table", range: "总表!A1:AH20", include: "values,formulas",
    tableMaxRows: 20, tableMaxCols: 34, maxChars: 15000,
  });
  const errors = await workbook.inspect({
    kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
  });
  const sheetText = sheets.ndjson;
  if (!sheetText.includes('"name":"总表"') || !sheetText.includes('"name":"未分组个人"')) {
    throw new Error(`${companyName} 缺少总表或未分组个人表`);
  }
  for (const team of expected.teams) {
    if (!sheetText.includes(`"name":"${team.name}"`)) throw new Error(`${companyName} 缺少团队表 ${team.name}`);
  }
  if (!errors.ndjson.includes("matched 0 entries") && !errors.ndjson.includes('"count":0') && !errors.ndjson.includes('"matches":[]')) {
    throw new Error(`${companyName} 公式错误扫描异常: ${errors.ndjson}`);
  }
  console.log(JSON.stringify({ company: companyName, file, expectedTeams: expected.teams.map((team) => team.name), expectedUngrouped: expected.ungroupedUsers.length }));
  console.log(sheets.ndjson);
  console.log(header.ndjson);
  console.log(errors.ndjson);
}
