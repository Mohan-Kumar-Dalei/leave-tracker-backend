import { ApiError } from '../utils/http.js';

// Every route declares what it accepts. Anything else is rejected before it
// reaches a query, which also closes operator injection through JSON bodies.
export function validate(schemas) {
  return (req, _res, next) => {
    req.valid = {};
    for (const source of ['params', 'query', 'body']) {
      if (!schemas[source]) continue;
      const result = schemas[source].safeParse(req[source] ?? {});
      if (!result.success) {
        const issue = result.error.issues[0];
        const error = new ApiError(400, issue.message, 'VALIDATION');
        error.field = issue.path.join('.');
        return next(error);
      }
      req.valid[source] = result.data;
    }
    return next();
  };
}
