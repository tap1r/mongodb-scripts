# Using _fsyncLock()_

Summary of valid backup approaches for a single _`mongod`_ (consistency of the data files). Backing up a sharded cluster or a replica set is a separate topic.

The 3.0–3.4 and MMAPv1 columns are below this repo's mongod 4.4 floor and are kept as the historical record. MMAPv1 was removed in 4.2. From 4.2 on, WiredTiger is the only storage engine. WiredTiger 4.0 through 9.0 matches the 3.4 column: the [3.2 `fsyncLock` guarantee](https://www.mongodb.com/docs/v4.4/release-notes/3.2/#wiredtiger-and-fsynclock) still applies. 8.x rapid releases match 8.0 for these rows. 9.0 is current.

||**WiredTiger**|**WiredTiger**|**WiredTiger**|**WiredTiger**|**WiredTiger**|**WiredTiger**|**WiredTiger**|**WiredTiger**|**WiredTiger**|**WiredTiger**|**WiredTiger**|**MMAPv1**|**MMAPv1**|
|-|-|-|-|-|-|-|-|-|-|-|-|-|-|
|**Approach**|**9.0**|**8.0**|**7.0**|**6.0**|**5.0**|**4.4**|**4.2**|**4.0**|**3.4**|**3.2**|**3.0**|**with journal**|**NO journal**&zwj;<sup>[1]</sup>|
|Cloud Manager, Ops Manager, or Atlas backup|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|
|clean _`mongod`_ shutdown (then file copy&zwj;<sup>[2]</sup> or snapshot)|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|
|file copy&zwj;<sup>[2]</sup> (while under _`fsyncLock()`_)|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:no_entry_sign:&nbsp;<sup>[6]</sup>|:white_check_mark:|:white_check_mark:|
|file copy&zwj;<sup>[2]</sup> (plain)|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|
|single&zwj;<sup>[3]</sup> atomic snapshot (while under _`fsyncLock()`_)|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|
|single&zwj;<sup>[3]</sup> atomic snapshot (plain)|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:&nbsp;<sup>[5]</sup>|:white_check_mark:|:no_entry_sign:|
|multiple&zwj;<sup>[3]</sup> atomic snapshots (while under _`fsyncLock()`_)|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:no_entry_sign:&nbsp;<sup>[6]</sup>|:white_check_mark:|:white_check_mark:|
|multiple&zwj;<sup>[3]</sup> atomic snapshots (plain)|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|:no_entry_sign:|
|_`mongodump --oplog`_&zwj;<sup>[4]</sup>|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|:white_check_mark:|

|Key||
|-|-|
|:white_check_mark:|Data files will be consistent.  Backup can be trusted.|
|:no_entry_sign:|Data files might be inconsistent.  Backup *cannot* be trusted.|

|Notes||
|-|-|
|1|Not recommended in normal situations.  Listed mainly for completeness.  MMAPv1 applies through 4.0 only|
|2|"File copy" includes any utility or program that reads files non-atomically, eg. _`cp`_, _`scp`_, _`rsync`_, _`tar`_, _`gzip`_ etc|
|3|"single" vs "multiple" refers to the number of snapshots required for the _entire_ _`dbPath`_.  This includes the contents of the journal directory, and any other directories if _`directoryPerDB`_ or _`directoryForIndexes`_ are in use|
|4|And also _`mongorestore --oplogReplay`_ when restoring.  Without this, the backup will be _consistent_, but might not be _point in time_.  Although _`mongodump`_/_`mongorestore`_ will never cause problems with the consistency of data files in the _`dbPath`_, they have other issues that often make them less desirable.  _`--oplog`_ requires a replica set|
|5|Journalling in WiredTiger is not _necessary_ to ensure data file consistency when using a single snapshot of the whole _`dbPath`_.  Journalling is still required in practice: a replica set cannot disable it from 4.0, and `storage.journal.enabled` is gone from 7.0|
|6|In MongoDB 3.0 with WiredTiger, _`fsyncLock()`_ only prevents user writes from occurring, and other system threads may modify the data files.  This has been [addressed since MongoDB v3.2](https://www.mongodb.com/docs/v4.4/release-notes/3.2/#wiredtiger-and-fsynclock)|
