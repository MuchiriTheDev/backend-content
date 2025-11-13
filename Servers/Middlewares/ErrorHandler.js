// middleware/errorHandler.js
import logger from "../Utilities/Logger.js";

const errorHandler = (err, req, res, next) => {
  // Log the error
  logger.error(`${err.name}: ${err.message} | Stack: ${err.stack}`);

  // Default error status and message
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Specific error handling (customize as needed)
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Validation Error',
      details: err.errors
    });
  }

  if (err.name === 'MongoError' && err.code === 11000) {
    return res.status(409).json({
      success: false,
      error: 'Duplicate Key Error',
      details: 'A resource with this value already exists'
    });
  }

  // Generic error response
  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }) // Include stack in dev
  });
};

export default errorHandler;