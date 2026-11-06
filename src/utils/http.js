export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new ApiError(400, message);
export const unauthorized = (message = 'Please sign in to continue.') => new ApiError(401, message, 'UNAUTHORIZED');
export const forbidden = (message = 'You do not have access to this.') => new ApiError(403, message);
export const notFound = (message = 'Not found.') => new ApiError(404, message);
export const conflict = (message) => new ApiError(409, message);

export function paginate(query) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  return { page, limit, skip: (page - 1) * limit };
}

export function pageMeta(total, { page, limit }) {
  return { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Spreadsheets run cells that start with = + - @ as formulas, so those get a
// leading apostrophe. Rows include text that employees typed.
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
