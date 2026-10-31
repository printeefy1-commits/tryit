import {assetUrl} from './asset-url.js';
// Runs only after the customer opens the mirror.
const vision=await import(assetUrl('/vendor/vision/vision_bundle.mjs'));
export const FaceLandmarker=vision.FaceLandmarker,FilesetResolver=vision.FilesetResolver;
