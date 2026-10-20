/**
 * Built-in local Identity groups.
 *
 * Groups are not directory records: they are principals a share may name.
 * The first one is the standing **All users** group every enabled person
 * belongs to by virtue of being a person in this vault. It has no membership
 * file; adding a person is joining it.
 */

export const ALL_USERS_GROUP_ID = "local_group_all_users";

export type LocalGroup = Readonly<{
  id: typeof ALL_USERS_GROUP_ID;
  name: string;
  kind: "group";
}>;

export const ALL_USERS_GROUP: LocalGroup = Object.freeze({
  id: ALL_USERS_GROUP_ID,
  name: "All users",
  kind: "group",
});
