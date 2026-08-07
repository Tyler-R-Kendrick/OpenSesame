pub use opensesame_domain::{DomainError, Grant};

pub fn delegate(parent: &Grant, mut child: Grant) -> Result<Grant, DomainError> {
    child.parent_grant_id = Some(parent.id);
    child.delegation_depth = parent.delegation_depth + 1;
    Grant::validate_attenuation(parent, &child)?;
    Ok(child)
}
