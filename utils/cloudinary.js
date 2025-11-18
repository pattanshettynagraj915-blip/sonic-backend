const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const fs = require('fs/promises');

let isConfigured = false;

function ensureConfigured() {
  if (isConfigured) return;
  const {
    CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET
  } = process.env;

  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Missing Cloudinary configuration. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in your environment.');
  }

  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true
  });

  isConfigured = true;
}

const DEFAULT_FOLDER = process.env.CLOUDINARY_UPLOAD_FOLDER || 'vendor-portal';

function buildUploadOptions(options = {}) {
  return {
    folder: options.folder || DEFAULT_FOLDER,
    resource_type: options.resourceType || 'auto',
    public_id: options.publicId || undefined,
    use_filename: options.useFilename !== undefined ? options.useFilename : true,
    unique_filename: options.uniqueFilename !== undefined ? options.uniqueFilename : true,
    overwrite: options.overwrite || false,
    transformation: options.transformation,
    tags: options.tags
  };
}

async function uploadFile(localPath, options = {}) {
  if (!localPath) {
    throw new Error('uploadFile requires a localPath');
  }

  ensureConfigured();
  const uploadOptions = buildUploadOptions(options);
  const result = await cloudinary.uploader.upload(localPath, uploadOptions);
  if (options.cleanup !== false) {
    await fs.unlink(localPath).catch(() => {});
  }
  return result;
}

async function uploadBuffer(buffer, options = {}) {
  if (!buffer) {
    throw new Error('uploadBuffer requires a buffer');
  }

  ensureConfigured();
  const uploadOptions = buildUploadOptions(options);

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });

    streamifier.createReadStream(buffer).pipe(stream);
  });
}

async function uploadMulterFile(file, options = {}) {
  if (!file) {
    throw new Error('No file provided for Cloudinary upload');
  }

  if (file.path) {
    return uploadFile(file.path, options);
  }

  if (file.buffer) {
    return uploadBuffer(file.buffer, options);
  }

  throw new Error('Unsupported file object for Cloudinary upload');
}

async function deleteAsset(publicId, resourceType = 'image') {
  if (!publicId) return null;
  ensureConfigured();
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType || 'image' });
}

function detectResourceTypeFromUrl(url) {
  if (!url || typeof url !== 'string') return 'image';
  if (url.includes('/video/')) return 'video';
  if (url.includes('/raw/')) return 'raw';
  return 'image';
}

function extractPublicIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.includes('/upload/')) return null;

  try {
    const [, remainder] = url.split('/upload/');
    if (!remainder) return null;
    const pathAndQuery = remainder.split(/[?#]/)[0];
    const parts = pathAndQuery.split('/');
    const withoutVersion = parts[0] && /^v\d+$/.test(parts[0]) ? parts.slice(1) : parts;
    const publicIdWithExtension = withoutVersion.join('/');
    const dotIndex = publicIdWithExtension.lastIndexOf('.');
    return dotIndex >= 0 ? publicIdWithExtension.substring(0, dotIndex) : publicIdWithExtension;
  } catch (err) {
    console.warn('Failed to extract Cloudinary public ID from URL:', err?.message || err);
    return null;
  }
}

module.exports = {
  uploadFileToCloudinary: uploadFile,
  uploadBufferToCloudinary: uploadBuffer,
  uploadMulterFileToCloudinary: uploadMulterFile,
  deleteCloudinaryAsset: deleteAsset,
  extractPublicIdFromUrl,
  detectResourceTypeFromUrl
};

