CREATE TABLE `server_update_control` (
  `id` integer PRIMARY KEY NOT NULL,
  `revision` integer NOT NULL,
  `payload` text NOT NULL,
  CONSTRAINT `server_update_control_singleton` CHECK (`id` = 1)
);
