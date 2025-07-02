# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# Note that this schema.rb definition is the authoritative source for your
# database schema. If you need to create the application database on another
# system, you should be using db:schema:load, not running all the migrations
# from scratch. The latter is a flawed and unsustainable approach (the more migrations
# you'll amass, the slower it'll run and the greater likelihood for issues).
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema.define(version: 2021_12_15_021648) do

  # These are extensions that must be enabled in order to support this database
  enable_extension "pgcrypto"
  enable_extension "plpgsql"
  enable_extension "uuid-ossp"

  create_table "curator_scopes", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "curator_id", null: false
    t.uuid "scope_id", null: false
    t.index ["curator_id"], name: "index_curator_scopes_on_curator_id"
    t.index ["scope_id"], name: "index_curator_scopes_on_scope_id", unique: true
  end

  create_table "highlights", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.integer "source_type", default: 0, null: false
    t.string "source_id", null: false
    t.jsonb "source_metadata"
    t.text "anchor", null: false
    t.text "highlighted_content", null: false
    t.text "annotation"
    t.string "color", null: false
    t.jsonb "location_strategies", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "scope_id"
    t.float "order_in_source", null: false
    t.uuid "prev_highlight_id"
    t.uuid "next_highlight_id"
    t.integer "content_path", array: true
    t.index ["next_highlight_id"], name: "index_highlights_on_next_highlight_id"
    t.index ["prev_highlight_id"], name: "index_highlights_on_prev_highlight_id"
    t.index ["scope_id"], name: "index_highlights_on_scope_id"
    t.index ["source_type"], name: "index_highlights_on_source_type"
    t.index ["user_id", "source_id"], name: "index_highlights_on_user_id_and_source_id"
    t.index ["user_id"], name: "index_highlights_on_user_id"
  end

  create_table "precalculateds", force: :cascade do |t|
    t.string "data_type", default: "info"
    t.json "data"
  end

  create_table "user_sources", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id"
    t.string "source_id", null: false
    t.string "source_type", null: false
    t.integer "num_highlights", default: 0
    t.index ["user_id", "source_id", "source_type"], name: "index_user_sources_on_user_id_and_source_id_and_source_type", unique: true
    t.index ["user_id"], name: "index_user_sources_on_user_id"
  end

  create_table "users", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.integer "num_annotation_characters", default: 0
    t.integer "num_highlights", default: 0
  end

  add_foreign_key "highlights", "highlights", column: "next_highlight_id"
  add_foreign_key "highlights", "highlights", column: "prev_highlight_id"
  add_foreign_key "user_sources", "users"
end