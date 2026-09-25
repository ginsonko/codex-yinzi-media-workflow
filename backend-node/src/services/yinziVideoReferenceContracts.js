// Shared with the offline prompt adapter. This is the exact user-supplied
// Seedance 2.5 channel contract recorded on 2026-09-14, not a family rule.
const SEEDANCE_25_REFERENCE_CONTRACT = Object.freeze({
  reference_template: '@{type}{index}',
  each_reference_must_be_mentioned: true,
  first_last_frame_supported: false,
  roles: Object.freeze({
    image: Object.freeze(['reference']),
    video: Object.freeze(['reference']),
    audio: Object.freeze(['reference']),
  }),
});

function getYinziVideoReferenceContract(model) {
  const name = String(model || '').trim().toLowerCase();
  return name === 'seedance 2.5' || name === 'seedance-2.5'
    ? SEEDANCE_25_REFERENCE_CONTRACT : null;
}

module.exports = { SEEDANCE_25_REFERENCE_CONTRACT, getYinziVideoReferenceContract };
