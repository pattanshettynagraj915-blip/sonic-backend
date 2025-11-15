const mysql = require('mysql2');

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'vendor_portal'
});

async function checkUsersTable() {
  try {
    const [rows] = await db.promise().query('DESCRIBE users');
    console.log('Users table structure:');
    rows.forEach(row => {
      console.log(`- ${row.Field}: ${row.Type} ${row.Null === 'NO' ? 'NOT NULL' : 'NULL'} ${row.Key ? row.Key : ''} ${row.Default ? 'DEFAULT ' + row.Default : ''}`);
    });
    
    // Check if there are any users
    const [userRows] = await db.promise().query('SELECT COUNT(*) as count FROM users');
    console.log(`\nUsers count: ${userRows[0].count}`);
    
    if (userRows[0].count > 0) {
      const [sampleUsers] = await db.promise().query('SELECT id, email, password FROM users LIMIT 3');
      console.log('\nSample users:');
      sampleUsers.forEach(user => {
        console.log(`- ID: ${user.id}, Email: ${user.email}, Has Password: ${user.password ? 'Yes' : 'No'}`);
      });
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkUsersTable();
