// src/utils/excel.js
// Opening-stock Excel parsing & validation engine.
// Extracted verbatim from the original index.js.

import * as XLSX from "xlsx";

export const REQUIRED_EXCEL_HEADERS = [
  "Item Code",
  "Item Description",
  "Quantity",
  "UOM",
  "Category",
  "Location",
  "Batch Number",
  "Manufacturing Date",
  "Expiry Date",
];
export const OPTIONAL_EXCEL_HEADERS = ["Case Conversion Qty"];

export const VALID_CATEGORIES = ["ambient", "frozen", "chiller"];

export function parseAndValidateExcel(arrayBuffer) {
  const errors = [];
  const warnings = [];

  let workbook;
  try {
    workbook = XLSX.read(new Uint8Array(arrayBuffer), {
      type: "array",
      cellDates: true,
    });
  } catch (err) {
    return {
      isValid: false,
      errors: ["Invalid Excel file format or corrupted file."],
      warnings: [],
      parsedRows: [],
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return {
      isValid: false,
      errors: ["Excel workbook contains no readable sheets."],
      warnings: [],
      parsedRows: [],
    };
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (!rawRows || rawRows.length < 2) {
    return {
      isValid: false,
      errors: [
        "Excel file must contain a header row and at least one data row.",
      ],
      warnings: [],
      parsedRows: [],
    };
  }

  // Header Validation
  const fileHeaders = rawRows[0].map((h) => String(h || "").trim());
  const headerMap = {};

  REQUIRED_EXCEL_HEADERS.forEach((reqHeader) => {
    const idx = fileHeaders.findIndex(
      (fh) => fh.toLowerCase() === reqHeader.toLowerCase(),
    );
    if (idx === -1) {
      errors.push(`Missing mandatory header column: "${reqHeader}"`);
    } else {
      headerMap[reqHeader] = idx;
    }
  });

  OPTIONAL_EXCEL_HEADERS.forEach((optHeader) => {
    const idx = fileHeaders.findIndex(
      (fh) => fh.toLowerCase() === optHeader.toLowerCase(),
    );
    if (idx !== -1) {
      headerMap[optHeader] = idx;
    }
  });

  if (errors.length > 0) {
    return { isValid: false, errors, warnings, parsedRows: [] };
  }

  // Row Data Validation
  const parsedRows = [];
  const duplicateTracker = new Set();

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    const excelRowNum = i + 1;

    // Check if entire row is empty
    const isEmptyRow = row.every((cell) => String(cell || "").trim() === "");
    if (isEmptyRow) continue;

    const itemCode = String(row[headerMap["Item Code"]] || "").trim();
    const itemDescription = String(
      row[headerMap["Item Description"]] || "",
    ).trim();
    const rawQuantity = row[headerMap["Quantity"]];
    const uom = String(row[headerMap["UOM"]] || "").trim();
    const category = String(row[headerMap["Category"]] || "").trim();
    const location = String(row[headerMap["Location"]] || "").trim();
    const batchNumber = String(row[headerMap["Batch Number"]] || "").trim();
    const rawMfgDate = row[headerMap["Manufacturing Date"]];
    const rawExpDate = row[headerMap["Expiry Date"]];
    const rawCaseConversionQty =
      headerMap["Case Conversion Qty"] !== undefined
        ? row[headerMap["Case Conversion Qty"]]
        : null;

    // Required Field Validations
    if (!itemCode) errors.push(`Row ${excelRowNum}: Item Code is mandatory.`);
    if (!itemDescription)
      errors.push(`Row ${excelRowNum}: Item Description is mandatory.`);
    if (!uom) errors.push(`Row ${excelRowNum}: UOM is mandatory.`);
    if (!location) errors.push(`Row ${excelRowNum}: Location is mandatory.`);

    // Quantity Validation
    const quantityNum = Number(rawQuantity);
    if (
      rawQuantity === "" ||
      rawQuantity === null ||
      isNaN(quantityNum) ||
      quantityNum <= 0
    ) {
      errors.push(
        `Row ${excelRowNum}: Quantity must be a valid numeric value greater than 0.`,
      );
    }

    // Category Validation (Case-insensitive)
    if (!category || !VALID_CATEGORIES.includes(category.toLowerCase())) {
      errors.push(
        `Row ${excelRowNum}: Category "${category}" is invalid. Allowed values: Ambient, Frozen, Chiller.`,
      );
    }

    // Date Validations
    const mfgDate = parseExcelDate(rawMfgDate);
    if (rawMfgDate && mfgDate === "INVALID") {
      errors.push(
        `Row ${excelRowNum}: Manufacturing Date "${rawMfgDate}" is not a valid date.`,
      );
    }

    const expDate = parseExcelDate(rawExpDate);
    if (rawExpDate && expDate === "INVALID") {
      errors.push(
        `Row ${excelRowNum}: Expiry Date "${rawExpDate}" is not a valid date.`,
      );
    }

    let caseConversionQty = null;
    if (
      rawCaseConversionQty !== null &&
      rawCaseConversionQty !== undefined &&
      String(rawCaseConversionQty).trim() !== ""
    ) {
      const parsedCaseQty = Number(rawCaseConversionQty);
      if (isNaN(parsedCaseQty) || parsedCaseQty <= 0) {
        errors.push(
          `Row ${excelRowNum}: Case Conversion Qty must be a valid positive number when provided.`,
        );
      } else {
        caseConversionQty = parsedCaseQty;
      }
    }

    if (mfgDate && expDate && mfgDate !== "INVALID" && expDate !== "INVALID") {
      if (new Date(expDate) < new Date(mfgDate)) {
        errors.push(
          `Row ${excelRowNum}: Expiry Date (${expDate}) cannot be earlier than Manufacturing Date (${mfgDate}).`,
        );
      }
    }

    // Duplicate Validation Warning
    const dupKey = `${itemCode.toLowerCase()}|${batchNumber.toLowerCase()}|${location.toUpperCase()}`;
    if (duplicateTracker.has(dupKey)) {
      warnings.push(
        `Row ${excelRowNum}: Duplicate item detected for Item Code "${itemCode}", Batch "${batchNumber || "N/A"}", and Location "${location.toUpperCase()}".`,
      );
    } else {
      duplicateTracker.add(dupKey);
    }

    parsedRows.push({
      item_code: itemCode,
      item_description: itemDescription,
      quantity: quantityNum,
      uom: uom,
      category: normalizeCategory(category),
      location: location.toUpperCase(),
      batch_number: batchNumber || null,
      manufacturing_date: mfgDate === "INVALID" ? null : mfgDate,
      expiry_date: expDate === "INVALID" ? null : expDate,
      case_conversion_qty: caseConversionQty,
    });
  }

  if (parsedRows.length === 0 && errors.length === 0) {
    errors.push("Excel file contains no data rows.");
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    totalRows: parsedRows.length,
    parsedRows,
  };
}

export function parseExcelDate(val) {
  if (val === null || val === undefined || val === "") return null;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? "INVALID" : val.toISOString().split("T")[0];
  }
  if (typeof val === "number") {
    const parsed = XLSX.SSF.parse_date_code(val);
    if (parsed) {
      const y = parsed.y;
      const m = String(parsed.m).padStart(2, "0");
      const d = String(parsed.d).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  const str = String(val).trim();
  const dateObj = new Date(str);
  return isNaN(dateObj.getTime())
    ? "INVALID"
    : dateObj.toISOString().split("T")[0];
}

export function normalizeCategory(cat) {
  const lower = String(cat).toLowerCase();
  if (lower === "frozen") return "Frozen";
  if (lower === "chiller") return "Chiller";
  return "Ambient";
}
