import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const inputPath = new URL("./team-usage-data.json", import.meta.url);
const outputDir = new URL("./公司报表/", import.meta.url);
const previewsDir = new URL("./previews-company/", import.meta.url);
const data = JSON.parse(await fs.readFile(inputPath, "utf8"));
const chronologicalDates = [...data.dates];
const dates = [...data.dates].reverse();
const snapshotDate = String(data.generatedAt).slice(0, 10);

const colors = {
  navy: "#1F4E78", blue: "#5B9BD5", pale: "#DDEBF7", light: "#F4F8FC",
  gold: "#FFF2CC", ink: "#203040", muted: "#667788", line: "#CFD8E3", white: "#FFFFFF",
};

function excelCol(n) {
  let s = "";
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function quoteSheet(name) { return `'${name.replaceAll("'", "''")}'`; }

function safeSheetName(raw, used) {
  const base = String(raw || "未命名小组").replace(/[\\/:?*\[\]]/g, "-").slice(0, 27) || "未命名小组";
  let name = base === "总表" || base === "未分组个人" ? `小组-${base}` : base;
  let i = 2;
  while (used.has(name)) {
    const suffix = `-${i++}`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name);
  return name;
}

function safeFileName(raw) {
  return String(raw || "未命名公司").replace(/[<>:\"/\\|?*]/g, "-").replace(/[. ]+$/g, "").slice(0, 60) || "未命名公司";
}

function memberTotal(member) {
  return dates.reduce((sum, day) => sum + (data.dailyByUser[member.id]?.[day] || 0), 0);
}

function groupTotal(group) { return group.members.reduce((sum, member) => sum + memberTotal(member), 0); }

const firstDateCol = 4;
const lastDateCol = firstDateCol + dates.length - 1;
const totalCol = lastDateCol + 1;
const firstDateLetter = excelCol(firstDateCol);
const lastDateLetter = excelCol(lastDateCol);
const lastColLetter = excelCol(totalCol);

function styleSheetBase(sheet) {
  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(5);
  sheet.freezePanes.freezeColumns(3);
}

function styleTitle(sheet, title, subtitle) {
  sheet.getRange(`A1:${lastColLetter}1`).merge();
  sheet.getRange("A1").values = [[title]];
  sheet.getRange(`A1:${lastColLetter}1`).format = {
    fill: colors.navy, font: { bold: true, color: colors.white, size: 16 }, verticalAlignment: "center",
  };
  sheet.getRange(`A1:${lastColLetter}1`).format.rowHeight = 32;
  sheet.getRange(`A2:${lastColLetter}2`).merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A2:${lastColLetter}2`).format = {
    fill: colors.light, font: { color: colors.muted, size: 10 }, verticalAlignment: "center",
  };
  sheet.getRange(`A2:${lastColLetter}2`).format.rowHeight = 24;
}

function styleHeader(sheet) {
  sheet.getRange(`A5:${lastColLetter}5`).format = {
    fill: colors.blue,
    font: { bold: true, color: colors.white, size: 10 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: colors.navy },
  };
  sheet.getRange(`A5:${lastColLetter}5`).format.rowHeight = 34;
  sheet.getRange("A:A").format.columnWidth = 18;
  sheet.getRange("B:B").format.columnWidth = 10;
  sheet.getRange("C:C").format.columnWidth = 18;
  sheet.getRange(`${firstDateLetter}:${lastDateLetter}`).format.columnWidth = 11;
  sheet.getRange(`${lastColLetter}:${lastColLetter}`).format.columnWidth = 15;
}

function addDetailSheet(workbook, group, index) {
  const sheet = workbook.worksheets.add(group.sheetName);
  styleSheetBase(sheet);
  const mode = group.creditMode === "shared" ? "共享积分" : group.creditMode === "dispatch" ? "分发积分" : "个人积分";
  styleTitle(
    sheet,
    `${group.name} · 每日消耗`,
    `${group.companyName}公司 · 生产快照 ${data.generatedAt} · UTC 自然日 · 失败请求不计 · ${chronologicalDates.at(-1)} 为部分日`,
  );
  sheet.getRange("A3:F3").values = [[group.isUngrouped ? "人数" : "成员数", group.members.length, "30天合计", null, "积分方式", mode]];
  sheet.getRange("D3").formulas = [[group.members.length ? `=SUM(${lastColLetter}6:${lastColLetter}${5 + group.members.length})` : "=0"]];
  sheet.getRange("A3:F3").format = { fill: colors.pale, font: { color: colors.ink }, verticalAlignment: "center" };
  sheet.getRange("A3:F3").format.rowHeight = 24;
  for (const cell of ["A3", "C3", "E3"]) sheet.getRange(cell).format.font = { bold: true, color: colors.navy };
  for (const cell of ["B3", "D3", "F3"]) sheet.getRange(cell).format.font = { bold: true, color: colors.ink };
  sheet.getRange("B3:D3").format.numberFormat = "#,##0";

  const headers = [group.isUngrouped ? "用户" : "成员", "身份", "账号", ...dates.map((day) => new Date(`${day}T00:00:00Z`)), "30天合计"];
  sheet.getRange(`A5:${lastColLetter}5`).values = [headers];
  sheet.getRange(`${firstDateLetter}5:${lastDateLetter}5`).format.numberFormat = "mm-dd";
  styleHeader(sheet);

  const members = [...group.members].sort((a, b) => {
    if (a.role !== b.role) return a.role === "团长" ? -1 : 1;
    return memberTotal(b) - memberTotal(a) || a.name.localeCompare(b.name, "zh-CN");
  });
  const startRow = 6;
  const rows = members.map((member) => [
    member.name, member.role, member.account,
    ...dates.map((day) => data.dailyByUser[member.id]?.[day] || 0),
    null,
  ]);
  const endRow = startRow + rows.length - 1;
  if (rows.length) {
    sheet.getRange(`A${startRow}:${lastColLetter}${endRow}`).values = rows;
    for (let row = startRow; row <= endRow; row++) {
      sheet.getRange(`${lastColLetter}${row}`).formulas = [[`=SUM(${firstDateLetter}${row}:${lastDateLetter}${row})`]];
    }
    sheet.getRange(`${firstDateLetter}${startRow}:${lastColLetter}${endRow}`).format.numberFormat = "#,##0";
    sheet.getRange(`${firstDateLetter}${startRow}:${lastColLetter}${endRow}`).format.horizontalAlignment = "right";
    sheet.getRange(`A${startRow}:${lastColLetter}${endRow}`).format.borders = {
      insideHorizontal: { style: "thin", color: colors.line }, bottom: { style: "thin", color: colors.line },
    };
    for (let row = startRow; row <= endRow; row++) {
      if ((row - startRow) % 2 === 1) sheet.getRange(`A${row}:${lastColLetter}${row}`).format.fill = colors.light;
    }
  }

  const totalRow = rows.length ? endRow + 1 : startRow;
  sheet.getRange(`A${totalRow}:C${totalRow}`).merge();
  sheet.getRange(`A${totalRow}`).values = [[group.isUngrouped ? "未分组合计" : "小组合计"]];
  for (let col = firstDateCol; col <= totalCol; col++) {
    const letter = excelCol(col);
    sheet.getRange(`${letter}${totalRow}`).formulas = [[rows.length ? `=SUM(${letter}${startRow}:${letter}${endRow})` : "=0"]];
  }
  sheet.getRange(`A${totalRow}:${lastColLetter}${totalRow}`).format = {
    fill: colors.gold, font: { bold: true, color: colors.ink }, numberFormat: "#,##0",
    borders: { preset: "doubleBottom", style: "medium", color: colors.navy },
  };

  const noteRow = totalRow + 2;
  sheet.getRange(`A${noteRow}:${lastColLetter}${noteRow}`).merge();
  sheet.getRange(`A${noteRow}`).values = [[group.isUngrouped
    ? `口径：仅含${group.companyName}公司内快照时点未加入任何团队的人员；未分组人员按个人公司标记归属。`
    : `口径：该团队整体归属${group.companyName}公司（以团长所属公司为准）；共享积分仍按实际发起请求的成员展示。`]];
  sheet.getRange(`A${noteRow}:${lastColLetter}${noteRow}`).format = {
    fill: colors.light, font: { italic: true, color: colors.muted, size: 9 }, wrapText: true,
  };
  sheet.getRange(`A${noteRow}:${lastColLetter}${noteRow}`).format.rowHeight = 28;
  if (rows.length) {
    const table = sheet.tables.add(`A5:${lastColLetter}${endRow}`, true, group.isUngrouped ? "UngroupedUsage" : `TeamUsage${String(index + 1).padStart(2, "0")}`);
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
  }
  return { totalRow };
}

async function buildCompanyWorkbook(company) {
  const workbook = Workbook.create();
  const usedNames = new Set(["总表", "未分组个人"]);
  const teams = [...company.teams]
    .map((team) => ({ ...team, companyName: company.name, total: groupTotal(team) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "zh-CN"))
    .map((team) => ({ ...team, sheetName: safeSheetName(team.name, usedNames) }));
  const ungrouped = {
    name: "未分组个人", companyName: company.name, creditMode: "personal",
    members: company.ungroupedUsers || [], sheetName: "未分组个人", isUngrouped: true,
  };
  ungrouped.total = groupTotal(ungrouped);

  const summary = workbook.worksheets.add("总表");
  const ungroupedRef = addDetailSheet(workbook, ungrouped, -1);
  const teamRefs = teams.map((team, index) => addDetailSheet(workbook, team, index));
  const categories = [
    { ...ungrouped, ref: ungroupedRef },
    ...teams.map((team, index) => ({ ...team, ref: teamRefs[index] })),
  ];

  styleSheetBase(summary);
  styleTitle(
    summary,
    `${company.name}公司 · 各团队近30天每日消耗总表`,
    `数据快照 ${data.generatedAt} · ${chronologicalDates[0]} 至 ${chronologicalDates.at(-1)}（UTC）· 今日为部分日`,
  );
  const summaryStart = 6;
  const summaryEnd = summaryStart + categories.length - 1;
  const grandTotalRow = summaryEnd + 1;
  const teamSummaryStart = summaryStart + 1;
  const teamSummaryEnd = summaryEnd;
  const memberCount = teams.reduce((sum, team) => sum + team.members.length, 0);
  summary.getRange("A3:N3").values = [[
    "公司", company.name, "团队数", teams.length, "组内成员", memberCount, "未分组人数", ungrouped.members.length,
    "组内30天消耗", null, "未分组30天消耗", null, "公司30天合计", null,
  ]];
  summary.getRange("J3").formulas = [[teams.length ? `=SUM(${lastColLetter}${teamSummaryStart}:${lastColLetter}${teamSummaryEnd})` : "=0"]];
  summary.getRange("L3").formulas = [[`=${lastColLetter}${summaryStart}`]];
  summary.getRange("N3").formulas = [[`=${lastColLetter}${grandTotalRow}`]];
  summary.getRange("A3:N3").format = { fill: colors.pale, font: { color: colors.ink }, verticalAlignment: "center" };
  summary.getRange("A3:N3").format.rowHeight = 24;
  for (const cell of ["A3", "C3", "E3", "G3", "I3", "K3", "M3"]) summary.getRange(cell).format.font = { bold: true, color: colors.navy };
  for (const cell of ["B3", "D3", "F3", "H3", "J3", "L3", "N3"]) summary.getRange(cell).format.font = { bold: true, color: colors.ink };
  summary.getRange("D3:N3").format.numberFormat = "#,##0";

  summary.getRange(`A5:${lastColLetter}5`).values = [["分类 / 小组", "积分方式", "人数", ...dates.map((day) => new Date(`${day}T00:00:00Z`)), "30天合计"]];
  summary.getRange(`${firstDateLetter}5:${lastDateLetter}5`).format.numberFormat = "mm-dd";
  styleHeader(summary);
  summary.getRange("A:A").format.columnWidth = 22;
  for (let index = 0; index < categories.length; index++) {
    const group = categories[index];
    const row = summaryStart + index;
    const mode = group.creditMode === "shared" ? "共享积分" : group.creditMode === "dispatch" ? "分发积分" : "个人积分";
    summary.getRange(`A${row}:C${row}`).values = [[group.name, mode, group.members.length]];
    for (let col = firstDateCol; col <= totalCol; col++) {
      const letter = excelCol(col);
      summary.getRange(`${letter}${row}`).formulas = [[`=${quoteSheet(group.sheetName)}!${letter}${group.ref.totalRow}`]];
    }
    if ((row - summaryStart) % 2 === 1) summary.getRange(`A${row}:${lastColLetter}${row}`).format.fill = colors.light;
  }
  summary.getRange(`${firstDateLetter}${summaryStart}:${lastColLetter}${summaryEnd}`).format.numberFormat = "#,##0";
  summary.getRange(`A${summaryStart}:${lastColLetter}${summaryEnd}`).format.borders = {
    insideHorizontal: { style: "thin", color: colors.line }, bottom: { style: "thin", color: colors.line },
  };

  summary.getRange(`A${grandTotalRow}:C${grandTotalRow}`).merge();
  summary.getRange(`A${grandTotalRow}`).values = [[`${company.name}公司合计`]];
  for (let col = firstDateCol; col <= totalCol; col++) {
    const letter = excelCol(col);
    summary.getRange(`${letter}${grandTotalRow}`).formulas = [[`=SUM(${letter}${summaryStart}:${letter}${summaryEnd})`]];
  }
  summary.getRange(`A${grandTotalRow}:${lastColLetter}${grandTotalRow}`).format = {
    fill: colors.gold, font: { bold: true, color: colors.ink }, numberFormat: "#,##0",
    borders: { preset: "doubleBottom", style: "medium", color: colors.navy },
  };
  const noteRow = grandTotalRow + 2;
  summary.getRange(`A${noteRow}:${lastColLetter}${noteRow}`).merge();
  summary.getRange(`A${noteRow}`).values = [[`公司隔离口径：团队按团长所属公司整组归属，未分组人员按个人公司标记归属；本文件只统计${company.name}公司，不含其他公司团队或员工。`]];
  summary.getRange(`A${noteRow}:${lastColLetter}${noteRow}`).format = {
    fill: colors.light, font: { italic: true, color: colors.muted, size: 9 }, wrapText: true,
  };
  summary.getRange(`A${noteRow}:${lastColLetter}${noteRow}`).format.rowHeight = 28;
  const summaryTable = summary.tables.add(`A5:${lastColLetter}${summaryEnd}`, true, "SummaryUsage");
  summaryTable.style = "TableStyleMedium2";
  summaryTable.showFilterButton = true;

  const safeCompany = safeFileName(company.name);
  await fs.mkdir(previewsDir, { recursive: true });
  for (const sheetName of ["总表", "未分组个人", ...teams.map((team) => team.sheetName)]) {
    const preview = await workbook.render({ sheetName, autoCrop: "all", scale: 0.8, format: "png" });
    await fs.writeFile(new URL(`${safeCompany}-${safeFileName(sheetName)}.png`, previewsDir), new Uint8Array(await preview.arrayBuffer()));
  }
  const inspect = await workbook.inspect({
    kind: "table", range: `总表!A1:${lastColLetter}${grandTotalRow}`, include: "values,formulas",
    tableMaxRows: Math.min(grandTotalRow, 30), tableMaxCols: 12, maxChars: 12000,
  });
  const errors = await workbook.inspect({
    kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 }, summary: `${company.name} formula error scan`,
  });
  await fs.mkdir(outputDir, { recursive: true });
  const path = decodeURIComponent(new URL(`Qiji生产环境-${safeCompany}公司-各团队近30天每日消耗-${snapshotDate}.xlsx`, outputDir).pathname).replace(/^\/(\w:)/, "$1");
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(path);
  return {
    company: company.name, path, sheets: categories.length + 1, teams: teams.map((team) => team.name),
    teamMembers: memberCount, ungroupedUsers: ungrouped.members.length,
    uniqueUsers: memberCount + ungrouped.members.length,
    teamTotal: teams.reduce((sum, team) => sum + team.total, 0),
    ungroupedTotal: ungrouped.total,
    total: teams.reduce((sum, team) => sum + team.total, 0) + ungrouped.total,
    inspect: inspect.ndjson, errors: errors.ndjson,
  };
}

const results = [];
for (const company of data.companies || []) results.push(await buildCompanyWorkbook(company));
await fs.writeFile(new URL("verification.json", outputDir), JSON.stringify(results, null, 2), "utf8");
console.log(JSON.stringify(results.map(({ inspect, errors, ...result }) => ({ ...result, formulaErrors: errors })), null, 2));
