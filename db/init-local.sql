-- Local and CI only. The app connects as bc_app, an ordinary (non-superuser) role, because
-- superusers skip row-level security and the tests must prove that security works.
-- On Azure the server admin is already not a superuser, so this file isn't used there.
CREATE ROLE bc_app LOGIN PASSWORD 'bc_app';
CREATE DATABASE bceditor OWNER bc_app;
CREATE DATABASE bceditor_test OWNER bc_app;
