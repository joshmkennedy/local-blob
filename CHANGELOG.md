# local-blobtastic

## 0.2.1

### Patch Changes

- 806cf56: Allow Chrome private-network preflights for client uploads to the local control plane.

## 0.2.0

### Minor Changes

- Add local private blob and presigned URL support.

  This release adds authenticated private object reads, local signed token issuance, presigned GET and HEAD reads, presigned single-part and multipart uploads, presigned deletes, and local upload-completed callback handling for presigned upload flows.

  It also updates the local URL model and documentation to describe control-plane and object-plane URLs, private bearer reads, presigned workflows, SDK `get()` limitations, and the expanded compatibility matrix.
