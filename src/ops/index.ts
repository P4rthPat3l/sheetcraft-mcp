import type { Op } from '../lib/types.js';
import { getValuesOp } from './values.js';
import {
  batchGetValuesOp,
  batchUpdateValuesOp,
  updateValuesOp,
  appendRowsOp,
  clearValuesOp,
} from './writing-values.js';
import {
  getSpreadsheetInfoOp,
  addSheetOp,
  deleteSheetOp,
  duplicateSheetOp,
  renameSheetOp,
  insertDeleteDimensionsOp,
  findReplaceOp,
} from './structure.js';
import {
  createChartOp,
  updateChartOp,
  deleteChartOp,
} from './charts.js';
import {
  createPivotOp,
  deletePivotOp,
} from './pivot.js';
import {
  batchUpdateOp,
  sortRangeOp,
} from './power.js';
import {
  formatCellsOp,
  mergeCellsOp,
  freezeRowsColumnsOp,
  conditionalFormatOp,
  getFormattingOp,
} from './formatting.js';
import {
  createSpreadsheetOp,
  copySpreadsheetOp,
  findSpreadsheetsOp,
  shareSpreadsheetOp,
  trashSpreadsheetOp,
  exportSpreadsheetOp,
  resolveTargetOp,
} from './drive.js';

export const ALL_OPS: readonly Op[] = [
  // core — values
  getValuesOp,
  batchGetValuesOp,
  updateValuesOp,
  batchUpdateValuesOp,
  appendRowsOp,
  clearValuesOp,
  // core — structure
  getSpreadsheetInfoOp,
  addSheetOp,
  deleteSheetOp,
  duplicateSheetOp,
  renameSheetOp,
  insertDeleteDimensionsOp,
  findReplaceOp,
  // drive — file lifecycle
  createSpreadsheetOp,
  copySpreadsheetOp,
  findSpreadsheetsOp,
  shareSpreadsheetOp,
  trashSpreadsheetOp,
  exportSpreadsheetOp,
  resolveTargetOp,
  // formatting group
  formatCellsOp,
  mergeCellsOp,
  freezeRowsColumnsOp,
  conditionalFormatOp,
  getFormattingOp,
  // charts group
  createChartOp,
  updateChartOp,
  deleteChartOp,
  // pivot group
  createPivotOp,
  deletePivotOp,
  // power group
  batchUpdateOp,
  sortRangeOp,
];