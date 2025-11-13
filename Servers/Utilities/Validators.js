export const validateUrl = (url) => {
  const urlPattern = /^https?:\/\/[^\s$.?#].[^\s]*$/;
  return urlPattern.test(url);
};

import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';

/**
 * Middleware to validate request inputs (body, params, query) based on a schema
 * @param {string} type - Type of input to validate ('body', 'param', 'query')
 * @param {Object} schema - Validation schema defining rules for each field
 * @returns {Array} - Array of validation middleware and error handler
 */
export const validate = (type, schema) => {
  const validators = [];

  // Process each field in the schema
  Object.entries(schema).forEach(([field, rules]) => {
    // Initialize the validation chain based on input type
    let chain;
    if (type === 'body') chain = body(field);
    else if (type === 'param') chain = param(field);
    else if (type === 'query') chain = query(field);
    else throw new Error(`Invalid validation type: ${type}`);

    // Apply validation rules
    if (rules.required) {
      chain = chain.exists().withMessage(`${field} is required`);
    }
    if (rules.optional) {
      chain = chain.optional({ checkFalsy: true });
    }
    if (rules.type === 'string') {
      chain = chain.isString().withMessage(`${field} must be a string`);
    }
    if (rules.type === 'number') {
      chain = chain.isNumeric().withMessage(`${field} must be a number`);
    }
    if (rules.minLength) {
      chain = chain
        .isLength({ min: rules.minLength })
        .withMessage(`${field} must be at least ${rules.minLength} characters`);
    }
    if (rules.maxLength) {
      chain = chain
        .isLength({ max: rules.maxLength })
        .withMessage(`${field} cannot exceed ${rules.maxLength} characters`);
    }
    if (rules.enum) {
      chain = chain
        .isIn(rules.enum)
        .withMessage(`${field} must be one of ${rules.enum.join(', ')}`);
    }
    if (rules.isMongoId) {
      chain = chain
        .custom((value) => mongoose.Types.ObjectId.isValid(value))
        .withMessage(`${field} must be a valid MongoDB ObjectID`);
    }

    validators.push(chain);
  });

  // Add error handling middleware
  validators.push((req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array().map((err) => ({
          field: err.param,
          message: err.msg,
        })),
      });
    }
    next();
  });

  return validators;
};