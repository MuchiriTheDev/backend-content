// utils/cloudinary.js
import { v2 as cloudinary } from 'cloudinary';
import logger from './Logger.js';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Upload file to Cloudinary
export const uploadToCloudinary = async (file) => {
  try {
    const result = await cloudinary.uploader.upload(file.path, {
      folder: 'cci/claims', // Organize files in a folder
      resource_type: 'auto', // Auto-detect file type (image, video, etc.)
      public_id: `${Date.now()}-${file.originalname}` // Unique file name
    });
    logger.info(`File uploaded to Cloudinary: ${result.secure_url}`);
    return {
      url: result.secure_url,
      publicId: result.public_id
    };
  } catch (error) {
    logger.error(`Cloudinary upload failed: ${error.message}`);
    throw error;
  }
};

// Delete file from Cloudinary
export const deleteFromCloudinary = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
    logger.info(`File deleted from Cloudinary: ${publicId}`);
  } catch (error) {
    logger.error(`Cloudinary delete failed: ${error.message}`);
    throw error;
  }
};

export default cloudinary;