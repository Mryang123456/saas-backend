-- ProcureFlow V1 baseline for MySQL 8.0+. This project was not deployed before
-- the provider migration, so this intentionally replaces the PostgreSQL baseline.

CREATE TABLE `tenants` (
  `id` CHAR(36) NOT NULL,
  `slug` VARCHAR(64) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `tenants_slug_key` (`slug`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `departments` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `manager_user_id` CHAR(36) NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `departments_tenant_id_status_idx` (`tenant_id`, `status`),
  UNIQUE INDEX `departments_tenant_id_name_key` (`tenant_id`, `name`),
  UNIQUE INDEX `departments_tenant_id_id_key` (`tenant_id`, `id`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `users` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `department_id` CHAR(36) NOT NULL,
  `username` VARCHAR(100) NOT NULL,
  `display_name` VARCHAR(100) NOT NULL,
  `role` ENUM('TENANT_ADMIN', 'EMPLOYEE', 'DEPT_MANAGER', 'FINANCE', 'TENANT_OWNER', 'AUDITOR') NOT NULL,
  `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `password_hash` VARCHAR(255) NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  `active_owner_tenant_id` CHAR(36) GENERATED ALWAYS AS (
    CASE WHEN `role` = 'TENANT_OWNER' AND `status` = 'ACTIVE' THEN `tenant_id` ELSE NULL END
  ) STORED,
  INDEX `users_tenant_id_department_id_status_idx` (`tenant_id`, `department_id`, `status`),
  INDEX `users_tenant_id_role_status_idx` (`tenant_id`, `role`, `status`),
  UNIQUE INDEX `users_tenant_id_id_key` (`tenant_id`, `id`),
  UNIQUE INDEX `users_tenant_id_username_key` (`tenant_id`, `username`),
  UNIQUE INDEX `one_active_owner_per_tenant` (`active_owner_tenant_id`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `sessions` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `token_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `sessions_token_hash_key` (`token_hash`),
  INDEX `sessions_tenant_id_user_id_idx` (`tenant_id`, `user_id`),
  INDEX `sessions_revoked_at_expires_at_idx` (`revoked_at`, `expires_at`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `purchase_applications` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `application_no` VARCHAR(32) NULL,
  `creator_id` CHAR(36) NOT NULL,
  `department_id` CHAR(36) NOT NULL,
  `title` VARCHAR(100) NOT NULL,
  `reason` TEXT NULL,
  `cost_center` VARCHAR(100) NULL,
  `currency` CHAR(3) NOT NULL DEFAULT 'CNY',
  `total_amount_cents` BIGINT NOT NULL DEFAULT 0,
  `status` ENUM('DRAFT', 'PENDING_DEPT_MANAGER', 'PENDING_FINANCE', 'PENDING_TENANT_OWNER', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'DRAFT',
  `current_approval_node` ENUM('DEPT_MANAGER', 'FINANCE', 'TENANT_OWNER') NULL,
  `submitted_at` DATETIME(3) NULL,
  `decided_at` DATETIME(3) NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  CONSTRAINT `amount_safe` CHECK (`total_amount_cents` BETWEEN 0 AND 9000000000000000),
  INDEX `purchase_applications_tenant_id_creator_id_updated_at_idx` (`tenant_id`, `creator_id`, `updated_at`),
  INDEX `purchase_applications_tenant_id_department_id_status_updated_idx` (`tenant_id`, `department_id`, `status`, `updated_at`),
  INDEX `purchase_applications_tenant_id_status_updated_at_idx` (`tenant_id`, `status`, `updated_at`),
  UNIQUE INDEX `purchase_applications_tenant_id_id_key` (`tenant_id`, `id`),
  UNIQUE INDEX `purchase_applications_tenant_id_application_no_key` (`tenant_id`, `application_no`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `purchase_application_items` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `application_id` CHAR(36) NOT NULL,
  `line_no` INTEGER NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `quantity` DECIMAL(16, 4) NOT NULL,
  `unit_price_cents` BIGINT NOT NULL,
  `line_amount_cents` BIGINT NOT NULL,
  `note` VARCHAR(500) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `item_amount_safe` CHECK (`unit_price_cents` BETWEEN 1 AND 9000000000000000 AND `line_amount_cents` BETWEEN 1 AND 9000000000000000),
  CONSTRAINT `quantity_positive` CHECK (`quantity` > 0),
  INDEX `purchase_application_items_tenant_id_application_id_idx` (`tenant_id`, `application_id`),
  UNIQUE INDEX `purchase_application_items_application_id_line_no_key` (`application_id`, `line_no`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `approval_records` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `application_id` CHAR(36) NOT NULL,
  `node` ENUM('DEPT_MANAGER', 'FINANCE', 'TENANT_OWNER') NOT NULL,
  `action` ENUM('APPROVE', 'REJECT') NOT NULL,
  `approver_id` CHAR(36) NOT NULL,
  `comment` VARCHAR(500) NULL,
  `from_status` ENUM('DRAFT', 'PENDING_DEPT_MANAGER', 'PENDING_FINANCE', 'PENDING_TENANT_OWNER', 'APPROVED', 'REJECTED') NOT NULL,
  `to_status` ENUM('DRAFT', 'PENDING_DEPT_MANAGER', 'PENDING_FINANCE', 'PENDING_TENANT_OWNER', 'APPROVED', 'REJECTED') NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `approval_records_tenant_id_approver_id_created_at_idx` (`tenant_id`, `approver_id`, `created_at`),
  UNIQUE INDEX `approval_records_application_id_node_key` (`application_id`, `node`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `workflow_events` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `application_id` CHAR(36) NOT NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `actor_id` CHAR(36) NOT NULL,
  `from_status` ENUM('DRAFT', 'PENDING_DEPT_MANAGER', 'PENDING_FINANCE', 'PENDING_TENANT_OWNER', 'APPROVED', 'REJECTED') NULL,
  `to_status` ENUM('DRAFT', 'PENDING_DEPT_MANAGER', 'PENDING_FINANCE', 'PENDING_TENANT_OWNER', 'APPROVED', 'REJECTED') NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `workflow_events_application_id_event_type_key` (`application_id`, `event_type`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `idempotency_keys` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `actor_id` CHAR(36) NOT NULL,
  `operation` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `request_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `response_status` INTEGER NULL,
  `response_body` JSON NULL,
  `resource_id` CHAR(36) NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idempotency_keys_expires_at_idx` (`expires_at`),
  UNIQUE INDEX `idempotency_keys_tenant_id_actor_id_operation_key_key` (`tenant_id`, `actor_id`, `operation`, `key`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `audit_logs` (
  `id` CHAR(36) NOT NULL,
  `tenant_id` CHAR(36) NOT NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `actor_id` CHAR(36) NULL,
  `target_type` VARCHAR(64) NOT NULL,
  `target_id` CHAR(36) NULL,
  `result` ENUM('SUCCESS', 'FAILURE') NOT NULL,
  `request_id` CHAR(36) NOT NULL,
  `ip_hash` CHAR(64) NULL,
  `change_summary` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `audit_logs_tenant_id_created_at_id_idx` (`tenant_id`, `created_at`, `id`),
  INDEX `audit_logs_tenant_id_event_type_created_at_idx` (`tenant_id`, `event_type`, `created_at`),
  INDEX `audit_logs_tenant_id_actor_id_created_at_idx` (`tenant_id`, `actor_id`, `created_at`),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `tenant_sequences` (
  `tenant_id` CHAR(36) NOT NULL,
  `sequence_date` DATE NOT NULL,
  `next_value` INTEGER NOT NULL,
  PRIMARY KEY (`tenant_id`, `sequence_date`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `departments` ADD CONSTRAINT `departments_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
-- MySQL forbids ON UPDATE CASCADE because users.tenant_id feeds the indexed
-- active_owner_tenant_id stored generated column.
ALTER TABLE `users` ADD CONSTRAINT `users_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `users` ADD CONSTRAINT `users_tenant_id_department_id_fkey` FOREIGN KEY (`tenant_id`, `department_id`) REFERENCES `departments` (`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_tenant_id_user_id_fkey` FOREIGN KEY (`tenant_id`, `user_id`) REFERENCES `users` (`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `purchase_applications` ADD CONSTRAINT `purchase_applications_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `purchase_applications` ADD CONSTRAINT `purchase_applications_tenant_id_creator_id_fkey` FOREIGN KEY (`tenant_id`, `creator_id`) REFERENCES `users` (`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `purchase_applications` ADD CONSTRAINT `purchase_applications_tenant_id_department_id_fkey` FOREIGN KEY (`tenant_id`, `department_id`) REFERENCES `departments` (`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `purchase_application_items` ADD CONSTRAINT `purchase_application_items_tenant_id_application_id_fkey` FOREIGN KEY (`tenant_id`, `application_id`) REFERENCES `purchase_applications` (`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `approval_records` ADD CONSTRAINT `approval_records_tenant_id_application_id_fkey` FOREIGN KEY (`tenant_id`, `application_id`) REFERENCES `purchase_applications` (`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `approval_records` ADD CONSTRAINT `approval_records_tenant_id_approver_id_fkey` FOREIGN KEY (`tenant_id`, `approver_id`) REFERENCES `users` (`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `workflow_events` ADD CONSTRAINT `workflow_events_tenant_id_application_id_fkey` FOREIGN KEY (`tenant_id`, `application_id`) REFERENCES `purchase_applications` (`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
