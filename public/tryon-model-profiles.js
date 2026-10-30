// Reviewed source fingerprints only. A profile must never be selected merely
// because an arbitrary uploaded mesh resembles another pair of glasses.
const profiles=new Map([
  ['20e5d272e646a7e33256a040568273de767d5d3d3cba2e8fe8c654382bbd7055',{
    label:'HEAD 12029',
    measurements:{reportedSpanMm:110,endpoints:'owner-described bridge-to-bridge span; exterior width not established',calibrated:false},
    templeFit:{firstLiftCm:.55,rearLiftCm:.8,splayCm:1,extensionCm:1.5}
  }],
  ['a013cbe08e711629e2a47a62560ca87b625dca8a0f20bdd4c6eae92f67c51514',{
    label:'HEAD 12028',
    measurements:{calibrated:false},
    frameDoubleSided:true,
    // This mesh already has longer, higher arms than the model-v1 source.
    templeFit:{firstLiftCm:.4,rearLiftCm:.65,splayCm:.9,extensionCm:.5}
  }],
  ['046f50c9b51e6d12d0956db2d60a4b0566c6d0455e5f2a374d8af939b198e0bf',{
    label:'HEAD 12028',measurements:{calibrated:false},authoredMaterials:true,
    templeFit:{firstLiftCm:.4,rearLiftCm:.65,splayCm:.9,extensionCm:.5}
  }]
]);

export function knownModelProfile(gltf){
  return profiles.get(gltf.asset?.extras?.lunetteCaba?.sourceSha256)||null;
}

// Shared by upload optimization and browser preview. Fingerprints are verified
// source files, never names supplied by an administrator.
const anchors=new Map([
  ['20e5d272e646a7e33256a040568273de767d5d3d3cba2e8fe8c654382bbd7055',{anchor:[-.00085,.14,.2114],referenceWidth:.9078}],
  ['046f50c9b51e6d12d0956db2d60a4b0566c6d0455e5f2a374d8af939b198e0bf',{anchor:[0,.135,.19],referenceWidth:.8858}],
  ['a013cbe08e711629e2a47a62560ca87b625dca8a0f20bdd4c6eae92f67c51514',{anchor:[0,.135,.19],referenceWidth:.8858}]
]);
export function knownFittingAnchor(sha256){const value=anchors.get(sha256);return value?{...value,anchor:[...value.anchor],sourceSha256:sha256}:null;}
