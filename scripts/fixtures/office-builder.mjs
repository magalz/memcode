// Native editable test outputs authored with the bundled Artifact Tool runtime.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Workbook,
  SpreadsheetFile,
  Presentation,
  PresentationFile,
} from "@oai/artifact-tool";
const [format, output, qa, runtimePython, skill] = process.argv.slice(2);
await fs.mkdir(qa, { recursive: true });
await fs.mkdir(path.dirname(output), { recursive: true });
const save = async (name, blob) =>
  fs.writeFile(path.join(qa, name), new Uint8Array(await blob.arrayBuffer()));
if (format === "xlsx") {
  const workbook = Workbook.create(),
    sheet = workbook.worksheets.add("Mission planner"),
    source = workbook.worksheets.add("Destinations");
  source.getRange("A2:D2").values = [
    ["Destination", "Travel days", "Crew", "Supplies per day"],
  ];
  source.getRange("A3:D5").values = [
    ["Mars", 210, 4, 12],
    ["Europa", 1040, 6, 14],
    ["Titan", 1250, 6, 15],
  ];
  source.getRange("A7").values = [
    ["Illustrative planning values for the Orbit demo."],
  ];
  sheet.getRange("A2").values = [["ORBIT MISSION PLANNER"]];
  sheet.getRange("A3").values = [
    ["Explore the resource cost of three fictional crewed missions."],
  ];
  sheet.getRange("A5:E5").values = [
    ["Destination", "Travel days", "Crew", "Daily supplies", "Total supplies"],
  ];
  for (let row = 6; row <= 8; row++) {
    const input = row - 3;
    sheet.getRange("A" + row + ":D" + row).formulas = [
      [
        "='Destinations'!A" + input,
        "='Destinations'!B" + input,
        "='Destinations'!C" + input,
        "='Destinations'!D" + input,
      ],
    ];
    sheet.getRange("E" + row).formulas = [
      ["=B" + row + "*C" + row + "*D" + row],
    ];
  }
  sheet.getRange("D10").values = [["Total"]];
  sheet.getRange("E10").formulas = [["=SUM(E6:E8)"]];
  sheet.getRange("A12").values = [
    ["Example data for artifact rendering. Change inputs in Destinations."],
  ];
  for (const target of [sheet, source]) {
    target.showGridLines = false;
    target.tabColor = target === sheet ? "#123B2A" : "#7EBF97";
    target.getRange("A1:F14").format.font = {
      name: "Arial",
      size: 11,
      color: "#183C2A",
    };
    target.getRange("A1:A14").format.columnWidth = 25;
    target.getRange("B1:E14").format.columnWidth = 19;
    target.getRange("A1:F14").format.rowHeight = 27;
  }
  sheet.getRange("A2:E2").format.font = {
    name: "Arial",
    size: 17,
    bold: true,
    color: "#123B2A",
  };
  sheet.getRange("A5:E5").format = {
    fill: "#123B2A",
    font: { name: "Arial", size: 11, bold: true, color: "#FFFFFF" },
    rowHeight: 32,
  };
  source.getRange("A2:D2").format = {
    fill: "#123B2A",
    font: { name: "Arial", size: 11, bold: true, color: "#FFFFFF" },
  };
  sheet.getRange("A6:E8").format.fill = "#F0F7EE";
  sheet.getRange("E6:E10").setNumberFormat("#,##0");
  sheet.getRange("D10:E10").format.font = {
    bold: true,
    size: 11,
    color: "#123B2A",
  };
  workbook.recalculate();
  const checked = await workbook.inspect({
    kind: "table",
    range: "'Mission planner'!A5:E10",
    include: "values,formulas",
    tableMaxRows: 8,
    tableMaxCols: 5,
    maxChars: 2500,
  });
  await fs.writeFile(path.join(qa, "workbook-inspection.json"), checked.ndjson);
  await save(
    "workbook-mission.png",
    await workbook.render({
      sheetName: "Mission planner",
      range: "A1:F13",
      scale: 1.5,
    }),
  );
  await save(
    "workbook-destinations.png",
    await workbook.render({
      sheetName: "Destinations",
      range: "A1:E9",
      scale: 1.5,
    }),
  );
  await (await SpreadsheetFile.exportXlsx(workbook)).save(output);
} else if (format === "pptx") {
  const presentation = Presentation.create({
    slideSize: { width: 1280, height: 720 },
  });
  const text = (
    slide,
    value,
    left,
    top,
    width,
    height,
    size,
    color = "#DDEEE4",
    bold = false,
  ) => {
    const shape = slide.shapes.add({
      geometry: "textbox",
      position: { left, top, width, height },
      fill: "none",
      line: { fill: "none", width: 0 },
    });
    shape.text = value;
    shape.text.style = { fontFamily: "Arial", fontSize: size, color, bold };
    return shape;
  };
  const box = (slide, left, top, width, height, fill) =>
    slide.shapes.add({
      geometry: "roundRect",
      position: { left, top, width, height },
      fill,
      line: { fill: "none", width: 0 },
    });
  const first = presentation.slides.add();
  first.background.fill = "#0B2118";
  text(first, "TIDELINE  /  FIELD NOTES", 72, 60, 800, 35, 18, "#6DCEB0", true);
  text(
    first,
    "An ocean of\nshared context.",
    72,
    160,
    800,
    210,
    76,
    "#F1F8EE",
    true,
  );
  text(
    first,
    "One live workspace for the person and the worker.\nSaved artifacts stay connected to the work.",
    78,
    435,
    800,
    90,
    28,
    "#ACCBB7",
  );
  text(first, "LOCAL BROWSER LAB  ·  CURSOR", 78, 625, 900, 32, 16, "#6DCEB0");
  box(first, 1010, 135, 30, 420, "#173E2D");
  box(first, 1060, 205, 30, 350, "#257858");
  box(first, 1110, 300, 30, 255, "#41C9A1");
  const second = presentation.slides.add();
  second.background.fill = "#F1F6EC";
  text(
    second,
    "SHARED WORK  /  CLEAR HANDOFFS",
    72,
    55,
    1050,
    35,
    17,
    "#3C8263",
    true,
  );
  text(
    second,
    "See the work as it happens.",
    72,
    135,
    1120,
    90,
    52,
    "#102D20",
    true,
  );
  const cards = [
    [
      "01",
      "Live browser",
      "The same tabs and page state\nfor the user and the worker.",
    ],
    [
      "02",
      "Persistent terminal",
      "Read output and send input\nto the same running process.",
    ],
    [
      "03",
      "Saved artifacts",
      "Open documents, sheets\nand slides directly in the card.",
    ],
  ];
  cards.forEach((c, i) => {
    const x = 72 + i * 388;
    box(second, x, 280, 356, 295, "#FFFFFF");
    text(second, c[0], x + 28, 305, 250, 50, 28, "#32926E", true);
    text(second, c[1], x + 28, 375, 300, 50, 28, "#102D20", true);
    text(second, c[2], x + 28, 450, 300, 85, 21, "#617E69");
  });
  text(
    second,
    "DEMO PRESENTATION  ·  EDITABLE NATIVE SHAPES",
    72,
    640,
    1100,
    28,
    14,
    "#7B937D",
  );
  for (const [i, slide] of presentation.slides.items.entries())
    await save(
      "slide-" + (i + 1) + ".png",
      await presentation.export({ slide, format: "png", scale: 1 }),
    );
  const staging = path.join(qa, "candidate.pptx");
  await (await PresentationFile.exportPptx(presentation)).save(staging);
  const { finalizePresentation } = await import(
    pathToFileURL(
      path.join(skill, "container_tools", "artifact_tool_utils.mjs"),
    ).href
  );
  await finalizePresentation({
    workspaceDir: path.dirname(qa),
    candidatePath: staging,
    finalPath: output,
    pythonExecutable: runtimePython,
    integrityValidatorPath: path.join(
      skill,
      "container_tools",
      "inspect_presentation_package_integrity.py",
    ),
    layoutValidatorPath: path.join(
      skill,
      "container_tools",
      "inspect_presentation_layout_geometry.py",
    ),
    layoutArgs: [
      "--expected-slide-size-emu",
      "12192000,6858000",
      "--validate-heading-fit",
    ],
    fontPolicy: { basis: "design", families: ["Arial"] },
    verifyArtifactToolImport: true,
    receiptPath: path.join(qa, "presentation-validation.json"),
  });
} else throw Error("Choose xlsx or pptx.");
console.log(JSON.stringify({ format, output, qa }));
