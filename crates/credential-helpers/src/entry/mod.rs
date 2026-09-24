//! The helper programs. `opensesame` runs one when it is invoked under the
//! helper's name (`git-credential-opensesame`, `docker-credential-opensesame`,
//! `opensesame-credential-process`, `opensesame-kube-exec`).
pub mod aws;
pub mod docker;
pub mod git;
pub mod kube;
